// 社員のツールの中身。役ごとに使えるツールを決め、入力を確かめてからゲートウェイが動かす (タスクとレビューの 2 章、3.1)
import {
  APPROVAL_KIND_LABEL,
  AppError,
  AskBossTool,
  AskOwnerTool,
  CheckpointTool,
  EXTENSION_TOOLS_MAX,
  type ExtensionToolSpec,
  IdeaAddTool,
  IssuePlanTool,
  newId,
  NodeAssignTool,
  NodeCreateTool,
  OWNER_INFO_ITEM,
  OwnerInfoReadTool,
  PrOpenTool,
  ReportTool,
  ReviewSubmitTool,
  ServiceCloseRequestTool,
  recordedText,
  ROLE_TOOLS,
  type StaffId,
  StaffRequestTool,
  StudySubmitTool,
  type ToolResult,
} from "@know-office/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z, type ZodType } from "zod";
import { approvals, nodes, notices, reviews, staff } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import type { ExtensionDefinition, ExtensionTool } from "../extensions/define.ts";
import { INSTALLED } from "../extensions/installed.ts";
import { enabledExtensions, extensionStore } from "../extensions/state.ts";
import { type GuardDeps, UNCONNECTED_DEPS } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { auditFrom } from "../ledger/record.ts";
import { closableService, createIdea, submitStudy } from "../services/flow.ts";
import { clockAt } from "./attendance.ts";
import { enqueueMirror, sendMirror } from "../github/mirror.ts";
import { repoScope } from "../github/rules.ts";
import { assertDocsPr } from "../devloop/docs-pr.ts";
import { issuePlan } from "../devloop/plan.ts";
import { announceNotice } from "../live/publish.ts";
import { askBoss, finishTask, type Forge, leaveTask, notifyStaff, staffDo } from "./loop.ts";
import { readOwnerData } from "./owner-data.ts";
import { addStaffMessage, reachCheckpoint } from "./progress.ts";
import { type Actor, appendNodeEvent, checkPair, createNode, findNode, moveNode, type NodeRow, updateNode } from "./nodes.ts";
import { backToTodo, findReview, madeTaskOf, mergeIfReady, repoRefusal } from "./review.ts";

/** 呼び出し 1 回 */
export type ToolCall = {
  /** 呼んだ社員 */
  staffId: StaffId;
  /** ツールの名前 */
  tool: string;
  /** 入力。ツールごとの Zod スキーマで確かめる */
  input: unknown;
  /** 今の時刻 */
  now: number;
  /** 要求のトレース ID */
  traceId?: string;
  /** 自動停止が外へ頼む口。ルールの外の操作を数える時に使う。無ければつないでいない口 */
  guard?: GuardDeps;
};

type Run = (env: Bindings, forge: Forge, call: ToolCall, input: never) => Promise<unknown>;

/** ツールの入力の形と中身 */
type Tool = { schema: ZodType; run: Run };

/** 役ごとに使えるツール。正本は core の ROLE_TOOLS で、ルールの判断と同じ一覧を使う。ここに無いツールは not_found で断る */
const ROLE_TOOL_NAMES: Record<StaffId, readonly string[]> = ROLE_TOOLS;

/** レビューのタスクを割り振る社員 */
const REVIEWER: StaffId = "reviewer";

/**
 * ツールの呼び出しから、誰がいつを作る
 * @param call 呼び出し
 * @returns 誰がいつ
 */
function actorOf(call: ToolCall): Actor {
  return { by: call.staffId, now: call.now, traceId: call.traceId };
}

/**
 * 社員の今のタスクを読む
 * @param env バインディング
 * @param call 呼び出し
 * @returns タスクの行
 * @throws conflict タスクを持っていない時
 */
async function currentTask(env: Bindings, call: ToolCall): Promise<NodeRow> {
  const { nodeId } = await staffDo(env, call.staffId).status(call.now);
  if (nodeId === null) throw new AppError("conflict", "今のタスクが無い");
  return findNode(env.DB, nodeId);
}

/** 承認を求めたツールの答え。承認済みと差し戻しは新しい承認を立てずに答えを返す。note は承認した後に起きる事 */
type Asked = { approvalId: string; status: "pending" | "approved" | "rejected"; reason?: string | null; note?: string };

/** タスクの移しが返す行 */
const Moved = z.array(z.object({ id: z.string() }));

/** 承認の中身のうち、社員の書いた理由 */
const AskedReason = z.object({ reason: z.string() }).loose();

/** 種類ごとの、承認した後に起きる事。社員の追加は承認しても増えない */
const ASK_NOTE: Partial<Record<string, string>> = { staff_add: "社員は 3 人に決まっていて、承認しても増えない" };

/**
 * オーナーの承認を求め、今のタスクを waiting_owner にして離れる。同じタスク、種類、対象の承認がもうあれば、新しく立てずにその答えを返す
 * @param env バインディング
 * @param call 呼び出し
 * @param approval 承認の種類、対象、中身
 * @param approval.kind 種類
 * @param approval.target 対象
 * @param approval.payload 中身
 * @returns 承認の ID と、今の答え。承認済みと差し戻しなら理由も
 * @throws conflict 今のタスクが無い時、読んだ後にタスクが変わった時
 */
async function waitOwner(env: Bindings, call: ToolCall, approval: { kind: "staff_add" | "role_change" | "external_integration" | "cost_increase" | "service_close"; target: string; payload: Record<string, unknown> }): Promise<Asked> {
  const task = await currentTask(env, call);
  const orm = drizzle(env.DB);
  const sameNode = sql`json_extract(${approvals.payload}, '$.nodeId') = ${task.id}`;
  const [before] = await orm
    .select({ id: approvals.id, status: approvals.status, reason: approvals.reason, payload: approvals.payload })
    .from(approvals)
    .where(and(eq(approvals.kind, approval.kind), eq(approvals.target, approval.target), sameNode))
    .orderBy(desc(approvals.requestedAt), desc(approvals.id))
    .limit(1);
  const note = ASK_NOTE[approval.kind];
  const extra = note === undefined ? {} : { note };
  // 答えの出た承認は輪にしない。承認済みなら進め、差し戻しなら理由を読んで直す。直して理由を変えた時だけ、差し戻しの後に新しく出し直す
  const resent = before?.status === "rejected" && AskedReason.safeParse(before.payload).data?.reason !== approval.payload["reason"];
  if ((before?.status === "approved" || before?.status === "rejected") && !resent) return { approvalId: before.id, status: before.status, reason: before.reason, ...extra };
  const reuse = before?.status === "pending" ? before : undefined;
  const id = reuse?.id ?? newId(clockAt(call.now));
  // 直前の移しがこのバッチで 1 行を変えた時だけ足す。同じ版を読んだ 2 つ目は、1 つ目が移した後の行を見ても足さない
  const moved = sql`changes() = 1`;
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    orm
      .update(nodes)
      .set({ status: "waiting_owner", version: task.version + 1, updatedAt: call.now })
      // 読んだ版のまま、この社員の作業中の時だけ待たせる
      .where(and(eq(nodes.id, task.id), eq(nodes.version, task.version), eq(nodes.status, "doing"), eq(nodes.assignee, call.staffId)))
      .returning({ id: nodes.id }),
  ];
  const noticeId = newId(clockAt(call.now));
  if (!reuse) {
    // タスクを待たせられた時だけ承認と通知を書く。3 つを 1 回で書き、途中で落ちても片方だけ残さない
    const payload = JSON.stringify({ ...approval.payload, nodeId: task.id });
    statements.push(
      orm
        .insert(approvals)
        .select(sql`SELECT ${id}, ${approval.kind}, ${approval.target}, ${payload}, 'pending', ${call.staffId}, ${call.now}, NULL, NULL WHERE ${moved}`),
      orm
        .insert(notices)
        .select(
          sql`SELECT ${noticeId}, ${call.now}, 'info', 'approval_requested', ${`承認を待っています: ${APPROVAL_KIND_LABEL[approval.kind]}`}, (SELECT ${staff.role} FROM ${staff} WHERE ${staff.id} = ${call.staffId}) || ': ' || ${approval.target}, ${task.scope}, NULL, ${`/approvals/${id}`} WHERE EXISTS (SELECT 1 FROM ${approvals} WHERE ${approvals.id} = ${id})`,
        ),
    );
  }
  const results: readonly unknown[] = await orm.batch(statements);
  if (Moved.parse(results[0]).length === 0) throw new AppError("conflict", "タスクが変わった");
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "waiting_owner", detail: { approvalId: id, kind: approval.kind } }, actorOf(call));
  // タスクを待たせられた時だけ承認と通知が書かれている
  if (!reuse) await announceNotice(env, noticeId, clockAt(call.now));
  if (!reuse) await auditFrom(env, { at: call.now, actor: call.staffId, action: "approval.request", target: id, scope: task.scope, detail: { kind: approval.kind, target: approval.target }, traceId: call.traceId });
  // 答えを待つ間は次のタスクを進める
  await leaveTask(env, call.staffId, "handed_back", call.now);
  return { approvalId: id, status: "pending", ...extra };
}

/**
 * 社長が目標の下にプロジェクトを、プロジェクトの下にタスクを作る
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input NodeCreateTool
 * @returns 作った物の ID
 */
async function nodeCreate(env: Bindings, _forge: Forge, call: ToolCall, input: NodeCreateTool): Promise<{ id: string }> {
  const parent = await findNode(env.DB, input.parentId);
  const row = await createNode(env, { ...input, scope: parent.scope, source: "president" }, actorOf(call));
  if (row.assignee !== null) await notifyStaff(env, row.assignee, call.now, false);
  return { id: row.id };
}

/**
 * 社長がタスクを社員に割り振る
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input NodeAssignTool
 * @returns 割り振ったタスクの ID
 */
async function nodeAssign(env: Bindings, _forge: Forge, call: ToolCall, input: NodeAssignTool): Promise<{ id: string }> {
  const row = await findNode(env.DB, input.nodeId);
  await updateNode(env, row.id, row.version, { assignee: input.assignee }, actorOf(call));
  await notifyStaff(env, input.assignee, call.now, false);
  return { id: row.id };
}

/**
 * 社長が社員の追加か役の変更をオーナーに求める。承認されるまで社員は変わらない
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input StaffRequestTool
 * @returns 承認の ID と今の答え
 */
function staffRequest(env: Bindings, _forge: Forge, call: ToolCall, input: StaffRequestTool): Promise<Asked> {
  return waitOwner(env, call, { kind: input.kind, target: input.kind === "staff_add" ? input.role : input.target, payload: { ...input } });
}

/**
 * 費用が増える事か新しい外部連携をオーナーに上げる
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input AskOwnerTool
 * @returns 承認の ID と今の答え
 */
function askOwner(env: Bindings, _forge: Forge, call: ToolCall, input: AskOwnerTool): Promise<Asked> {
  return waitOwner(env, call, { kind: input.kind, target: input.target, payload: { reason: input.reason } });
}

/**
 * 社員が案を足す。オーナーの案と同じくアイデアの段階に並ぶ
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input IdeaAddTool
 * @returns 足したサービスの ID
 */
async function ideaAdd(env: Bindings, _forge: Forge, call: ToolCall, input: IdeaAddTool): Promise<{ id: string }> {
  const row = await createIdea(env, input, actorOf(call));
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "service.create", target: row.id, scope: "office", detail: { name: row.name, kind: row.kind }, traceId: call.traceId });
  return { id: row.id };
}

/**
 * 社長が検討の段階の案を調べた材料を出す。オーナーはサービスの詳細で読んで決める
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input StudySubmitTool
 * @returns 材料を置いた鍵
 */
async function studySubmit(env: Bindings, _forge: Forge, call: ToolCall, input: StudySubmitTool): Promise<{ key: string }> {
  const key = await submitStudy(env, input.serviceId, input.body, call.now);
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "service.study", target: input.serviceId, scope: "office", detail: { key }, traceId: call.traceId });
  return { key };
}

/**
 * 社員がサービスを閉じる案をオーナーに出す。オーナーが承認するまでサービスは閉じない
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input ServiceCloseRequestTool
 * @returns 承認の ID と今の答え
 * @throws conflict サービスか運用の段階でない時
 */
async function serviceCloseRequest(env: Bindings, _forge: Forge, call: ToolCall, input: ServiceCloseRequestTool): Promise<Asked> {
  await closableService(env.DB, input.serviceId);
  return waitOwner(env, call, { kind: "service_close", target: input.serviceId, payload: { reason: input.reason } });
}

/**
 * 上司に次のタスクを求める
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input AskBossTool
 * @returns 上司の plan のタスクの ID
 * @throws conflict 上司がいない時 (社長は ask_owner を使う)
 */
async function askBossTool(env: Bindings, _forge: Forge, call: ToolCall, input: AskBossTool): Promise<{ id: string }> {
  const row = await askBoss(env, call.staffId, input.reason, call.now);
  if (!row) throw new AppError("conflict", "上司がいない");
  return { id: row.id };
}

/**
 * 開発担当が今のタスクのブランチからプルリクエストを出す。タスクはレビューを待ち、レビュー担当にレビューのタスクを足す
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼び出し
 * @param input PrOpenTool
 * @returns プルリクエストの番号とブランチ
 * @throws conflict 今のタスクが無いか、直すリポジトリが無い時、レビュー担当が作った社員と同じモデルの時、出す間にタスクの担当か状態が変わった時
 * @throws validation_failed 設計書のリポジトリで、設計書の形が違う時
 * @throws upstream_failed 設計書の木を読み切れない時
 */
async function prOpen(env: Bindings, forge: Forge, call: ToolCall, input: PrOpenTool): Promise<{ number: number; branch: string }> {
  const task = await currentTask(env, call);
  if (task.repo === null) throw new AppError("conflict", "タスクに直すリポジトリが無い");
  // レビューを割り振れないなら、GitHub に出す前に断る
  await checkPair(env.DB, call.staffId, REVIEWER);
  const branch = `ko/${task.id.slice(0, 8)}-${input.name}`;
  // 設計書のリポジトリは、ブランチの先を 1 つのコミットに固定し、変えた道と形の確かめを同じコミットで読む
  const docs = (await repoScope(env.DB, task.repo)).docs;
  const head = docs ? await forge.branchHead(task.repo, branch) : branch;
  const refusal = await repoRefusal(env, forge, { action: "pull_request", repo: task.repo, branch: head });
  if (refusal !== null) {
    // ルールの外の操作として数える。触れない所に当たった時は、そのファイルへの書き込みとして数える
    const op = refusal.path === undefined ? { operation: "office.tool" as const, target: `${task.repo} pull_request` } : { operation: "file.write" as const, target: `${task.repo}/${refusal.path}` };
    await observe(env, { type: "rule_denied", staffId: call.staffId, nodeId: task.id, operation: op.operation, target: recordedText(op.target) }, call.now, call.guard ?? UNCONNECTED_DEPS, call.traceId);
    throw new AppError("rule_denied", refusal.reason);
  }
  // 形の外れた設計書と、別のサービスの置き場を変える設計書のタスクは、GitHub に PR を出す前に断る
  if (docs) await assertDocsPr(env.DB, forge, task, head);
  const pr = await forge.openPull({ repo: task.repo, branch, title: input.title, body: input.body });
  // 出す間にオーナーが名前などを直すとバージョンが進むので、読み直して、まだこの社員の作業中の時だけ移す
  const fresh = await findNode(env.DB, task.id);
  if (fresh.status !== "doing" || fresh.assignee !== call.staffId) throw new AppError("conflict", "タスクが変わった");
  const moved = await moveNode(env.DB, fresh, "review", call.now, { branch, prNumber: pr.number });
  if (!moved) throw new AppError("conflict", "タスクが変わった");
  await drizzle(env.DB)
    .insert(reviews)
    .values({ id: newId(clockAt(call.now)), nodeId: task.id, repo: task.repo, prNumber: pr.number, branch, baseSha: pr.baseSha, headSha: pr.headSha });
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "pr_opened", detail: { prNumber: pr.number, branch } }, actorOf(call));
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "pull_request.open", target: task.id, scope: task.scope, detail: { repo: task.repo, prNumber: pr.number }, traceId: call.traceId });
  await createNode(
    env,
    { kind: "task", parentId: moved.parentId ?? undefined, scope: moved.scope, title: `レビュー: ${moved.title}`, taskKind: "review", assignee: REVIEWER, repo: task.repo, branch, prNumber: pr.number, source: "review", priority: moved.priority },
    { by: "system", now: call.now, traceId: call.traceId },
  );
  await leaveTask(env, call.staffId, "done", call.now);
  await notifyStaff(env, REVIEWER, call.now, false);
  return { number: pr.number, branch };
}

/**
 * レビュー担当が今のレビューのタスクに承認か差し戻しを出す。差し戻しは理由と一緒に作った社員のタスクに戻し、承認はチェックが通っていれば main に入れる
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼び出し
 * @param input ReviewSubmitTool
 * @returns main に入れたか
 * @throws conflict 今のタスクがレビューでない時、確かめるタスクが無いか review でない時、読んだ先 (headSha) がレビューの今の先と違う時、確かめるタスクが読んだ後に変わった時
 */
async function reviewSubmit(env: Bindings, forge: Forge, call: ToolCall, input: ReviewSubmitTool): Promise<{ merged: boolean }> {
  const review = await currentTask(env, call);
  if (review.taskKind !== "review" || review.repo === null || review.prNumber === null || review.branch === null) throw new AppError("conflict", "今のタスクはレビューでない");
  const made = await madeTaskOf(env.DB, review.repo, review.prNumber);
  if (!made) throw new AppError("conflict", "確かめるタスクが無い");
  // 見送られたタスクや、もう入れたタスクを main に入れない
  if (made.status !== "review") throw new AppError("conflict", "確かめるタスクがレビューを待っていない");
  const row = await findReview(env.DB, made.id);
  const clock = clockAt(call.now);
  const db = env.DB;
  // 読んだ先がレビューの今の先のままで、確かめるタスクがまだレビューを待つ時だけ、判断、GitHub に写す順番待ち、差し戻しならタスクを todo に戻す事を 1 回のバッチで書く
  const when = { sql: "EXISTS (SELECT 1 FROM reviews WHERE id = ? AND head_sha = ?) AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND status = 'review')", args: [row.id, input.headSha, made.id] };
  const mirror = enqueueMirror(env, row.id, { kind: "review", payload: { event: input.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES", body: input.summary, commitId: input.headSha } }, clock, when);
  const statements = [
    db
      .prepare("UPDATE reviews SET reviewer_verdict = ?, reviewer_summary = ? WHERE id = ? AND head_sha = ? AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND status = 'review')")
      .bind(input.verdict, input.summary, row.id, input.headSha, made.id),
    mirror.statement,
  ];
  if (input.verdict === "reject") statements.push(backToTodo(db, made.id, call.now, when));
  const [updated] = await db.batch(statements);
  if ((updated?.meta.changes ?? 0) === 0) throw new AppError("conflict", "確かめた後に変更が足されたか、確かめるタスクが変わった");
  // 出来事の node_events は年ごとの記録の D1 にあり、同じバッチに入れられないので、書けた後に足す
  const actor = actorOf(call);
  let merged = false;
  if (input.verdict === "reject") {
    await appendNodeEvent(env, { nodeId: made.id, staffId: call.staffId, kind: "review_rejected", detail: { summary: input.summary } }, actor);
  } else {
    const approved = { staffId: call.staffId, kind: "review_approved", detail: { summary: input.summary } };
    // 承認は書いた行から読む。書いた後に先が進んでいれば、その通知が承認を消している
    merged = await mergeIfReady(env, forge, made, { repo: review.repo, branch: review.branch, prNumber: review.prNumber, reviewer: null }, approved, actor, call.guard ?? UNCONNECTED_DEPS);
  }
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "review.submit", target: made.id, scope: made.scope, detail: { verdict: input.verdict, merged }, traceId: call.traceId });
  await finishTask(env, call.staffId, review.id, call.now);
  if (input.verdict === "reject" && made.assignee !== null) await notifyStaff(env, made.assignee, call.now, false);
  // 写せなければ記録に残し、5 分ごとの定期ジョブが写し直す
  await sendMirror(env, forge, mirror.id, clock);
  return { merged };
}

/**
 * 今のタスクのチェックポイントを伝える。社員 DO と出来事に渡し、残りが 10 分を切った作業トークンを差し替える
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input CheckpointTool
 * @returns 作業トークンを差し替えたか
 * @throws conflict 今のタスクが無い時
 */
async function checkpoint(env: Bindings, _forge: Forge, call: ToolCall, input: CheckpointTool): Promise<{ renewed: boolean }> {
  const task = await currentTask(env, call);
  const renewed = await reachCheckpoint(env, call.staffId, { kind: input.kind, nodeId: task.id, ...(input.note === undefined ? {} : { note: input.note }) }, call.now, call.traceId);
  return { renewed };
}

/**
 * オーナーへの発言を会話に足す
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input ReportTool
 * @returns 足した発言の ID
 * @throws conflict 今のタスクが無い時
 */
async function report(env: Bindings, _forge: Forge, call: ToolCall, input: ReportTool): Promise<{ id: string }> {
  const task = await currentTask(env, call);
  return { id: await addStaffMessage(env, { staffId: call.staffId, nodeId: task.id, body: input.body }, call.now, call.traceId) };
}

/**
 * ルールで許したオーナーの情報の 1 項目を読む。読んだ記録を残し、自動停止の重なった怪しい動きに数える
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input OwnerInfoReadTool
 * @returns 項目と値
 * @throws conflict 今のタスクが無い時
 * @throws not_found 項目が無い時
 */
async function ownerInfoRead(env: Bindings, _forge: Forge, call: ToolCall, input: OwnerInfoReadTool): Promise<{ item: string; value: string }> {
  const task = await currentTask(env, call);
  const [, extId = "", field = ""] = OWNER_INFO_ITEM.exec(input.item) ?? [];
  const value = await readOwnerData(env.DB, env.MASTER_KEY, { extId, field, staffId: call.staffId, nodeId: task.id }, call.now);
  await observe(env, { type: "owner_info_read", item: input.item }, call.now, call.guard ?? UNCONNECTED_DEPS, call.traceId);
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "owner_info.read", target: input.item, scope: task.scope, detail: { nodeId: task.id }, traceId: call.traceId });
  return { item: input.item, value };
}

/** ツールの名前から、入力の形と中身 */
const TOOLS: Record<string, Tool> = {
  node_create: { schema: NodeCreateTool, run: nodeCreate },
  node_assign: { schema: NodeAssignTool, run: nodeAssign },
  staff_request: { schema: StaffRequestTool, run: staffRequest },
  ask_boss: { schema: AskBossTool, run: askBossTool },
  ask_owner: { schema: AskOwnerTool, run: askOwner },
  pr_open: { schema: PrOpenTool, run: prOpen },
  review_submit: { schema: ReviewSubmitTool, run: reviewSubmit },
  idea_add: { schema: IdeaAddTool, run: ideaAdd },
  study_submit: { schema: StudySubmitTool, run: studySubmit },
  // 社長が設計書から親と子の Issue を作る。題と本文はゲートウェイが決まった形で作る
  issue_plan: { schema: IssuePlanTool, run: (env, forge, call, input: IssuePlanTool) => issuePlan(env, forge, input, actorOf(call)) },
  service_close_request: { schema: ServiceCloseRequestTool, run: serviceCloseRequest },
  checkpoint: { schema: CheckpointTool, run: checkpoint },
  report: { schema: ReportTool, run: report },
  owner_info_read: { schema: OwnerInfoReadTool, run: ownerInfoRead },
};

/** 拡張のツールのゲートウェイでの名前。`ext__<拡張 ID>__<ツール>` */
const EXT_TOOL_NAME = /^ext__([a-z][a-z\d-]*)__([a-z][a-z\d_]*)$/;

/**
 * 入れている拡張のツールを、ゲートウェイでの名前で並べる
 * @param env バインディング
 * @param extensions 読み込んだ拡張
 * @returns 名前からツールと拡張への対応
 */
async function extensionTools(env: Bindings, extensions: readonly ExtensionDefinition[]): Promise<Map<string, { ext: ExtensionDefinition; tool: ExtensionTool }>> {
  const out = new Map<string, { ext: ExtensionDefinition; tool: ExtensionTool }>();
  for (const ext of await enabledExtensions(env.DB, extensions)) {
    for (const [name, tool] of Object.entries(ext.tools)) out.set(`ext__${ext.id}__${name}`, { ext, tool });
  }
  return out;
}

/**
 * 入れている拡張のツールを、ワークスペースに渡す形で並べる。入力の形は拡張の Zod スキーマを JSON Schema に直した物
 * @param env バインディング
 * @param extensions 読み込んだ拡張
 * @returns 名前、説明、入力の形。上限の数まで
 */
export async function extensionToolSpecs(env: Bindings, extensions: readonly ExtensionDefinition[] = INSTALLED): Promise<ExtensionToolSpec[]> {
  return [...(await extensionTools(env, extensions))].slice(0, EXTENSION_TOOLS_MAX).map(([name, { ext, tool }]) => ({
    name,
    description: tool.description ?? `${ext.title}の拡張のツール`,
    inputSchema: z.toJSONSchema(tool.schema, { io: "input", unrepresentable: "any" }),
  }));
}

/**
 * 社員が今使えるツールの名前を並べる。役のツールに、入れている拡張のツールを足す
 * @param env バインディング
 * @param staffId 社員 ID
 * @param extensions 読み込んだ拡張
 * @returns ゲートウェイでのツールの名前
 */
export async function staffTools(env: Bindings, staffId: StaffId, extensions: readonly ExtensionDefinition[] = INSTALLED): Promise<string[]> {
  return [...ROLE_TOOL_NAMES[staffId], ...(await extensionTools(env, extensions)).keys()];
}

/**
 * 社員のツールを 1 回動かす。テストと、確かめを済ませた呼び出しが使う
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param call 呼び出し
 * @param extensions 読み込んだ拡張
 * @returns 社員に返す答え。中身は JSON の文字列
 * @throws not_found その社員の役では使えないツールの時、入れていない拡張のツールの時
 * @throws validation_failed 入力がツールの形に合わない時
 * @throws conflict 今のタスクが無いなど、今の状態では動かせない時
 */
export async function runTool(env: Bindings, forge: Forge, call: ToolCall, extensions: readonly ExtensionDefinition[] = INSTALLED): Promise<ToolResult> {
  return (await prepareTool(env, forge, call, extensions))();
}

/**
 * 社員のツールを探し、入力を確かめて、動かす関数を返す。`POST /ws/v1/tools/{toolName}` は、作業トークンのタスクが今のタスクである事を確かめてからこれを通し、ルールの判断をしてから動かす
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param call 呼び出し
 * @param extensions 読み込んだ拡張
 * @returns 動かして社員に返す答えを作る関数
 * @throws not_found その社員の役では使えないツールの時、入れていない拡張のツールの時
 * @throws validation_failed 入力がツールの形に合わない時
 */
export async function prepareTool(env: Bindings, forge: Forge, call: ToolCall, extensions: readonly ExtensionDefinition[] = INSTALLED): Promise<() => Promise<ToolResult>> {
  if (EXT_TOOL_NAME.test(call.tool)) return prepareExtensionTool(env, call, extensions);
  const tool = ROLE_TOOL_NAMES[call.staffId].includes(call.tool) ? TOOLS[call.tool] : undefined;
  if (!tool) throw new AppError("not_found", "この社員の役では使えないツール");
  const input = tool.schema.safeParse(call.input);
  if (!input.success) throw new AppError("validation_failed", "ツールの入力の形が違う");
  return async () => {
    // 入力は上でツールごとのスキーマに通した物なので、そのツールの中身に渡せる
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = await tool.run(env, forge, call, input.data as never);
    return { content: JSON.stringify(result), isError: false };
  };
}

/**
 * 入れている拡張のツールを探し、入力を確かめて、動かす関数を返す。拡張には時刻とその拡張の置き場だけを渡し、オーナーの情報は渡さない
 * @param env バインディング
 * @param call 呼び出し
 * @param extensions 読み込んだ拡張
 * @returns 動かして社員に返す答えを作る関数
 * @throws not_found 入れていない拡張のツールの時
 * @throws validation_failed 入力がツールの形に合わない時
 */
async function prepareExtensionTool(env: Bindings, call: ToolCall, extensions: readonly ExtensionDefinition[]): Promise<() => Promise<ToolResult>> {
  const found = (await extensionTools(env, extensions)).get(call.tool);
  if (!found) throw new AppError("not_found", "入れていない拡張のツール");
  const input = found.tool.schema.safeParse(call.input);
  if (!input.success) throw new AppError("validation_failed", "ツールの入力の形が違う");
  return async () => {
    // 入力は上でツールのスキーマに通した物なので、そのツールの中身に渡せる
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = await found.tool.run({ now: call.now, store: extensionStore(env.FILES, found.ext.id), ownerData: null }, input.data as never);
    return { content: JSON.stringify(result), isError: false };
  };
}
