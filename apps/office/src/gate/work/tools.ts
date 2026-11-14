// 社員のツールの中身。役ごとに使えるツールを決め、入力を確かめてからゲートウェイが動かす (タスクとレビューの 1.2、3.1)
import {
  AppError,
  AskBossTool,
  AskOwnerTool,
  newId,
  NodeAssignTool,
  NodeCreateTool,
  PrOpenTool,
  ReviewSubmitTool,
  type StaffId,
  StaffRequestTool,
  type ToolResult,
} from "@know-office/core";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ZodType } from "zod";
import { approvals, nodes, reviews } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { auditFrom } from "../ledger/record.ts";
import { clockAt } from "./attendance.ts";
import { askBoss, finishTask, type Forge, leaveTask, notifyStaff, staffDo } from "./loop.ts";
import { type Actor, appendNodeEvent, checkPair, createNode, findNode, moveNode, type NodeRow, revertNode, updateNode } from "./nodes.ts";

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
};

type Run = (env: Bindings, forge: Forge, call: ToolCall, input: never) => Promise<unknown>;

/** ツールの入力の形と中身 */
type Tool = { schema: ZodType; run: Run };

/** 役ごとに使えるツール。ここに無いツールは not_found で断る */
const ROLE_TOOLS: Record<StaffId, readonly string[]> = {
  president: ["node_create", "node_assign", "staff_request", "ask_boss", "ask_owner"],
  builder: ["pr_open", "ask_boss", "ask_owner"],
  reviewer: ["review_submit", "ask_boss", "ask_owner"],
};

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

/**
 * オーナーの承認を求め、今のタスクを waiting_owner にして離れる
 * @param env バインディング
 * @param call 呼び出し
 * @param approval 承認の種類、対象、中身
 * @param approval.kind 種類
 * @param approval.target 対象
 * @param approval.payload 中身
 * @returns 承認の ID
 * @throws conflict 今のタスクが無い時、読んだ後にタスクが変わった時
 */
async function waitOwner(env: Bindings, call: ToolCall, approval: { kind: "staff_add" | "role_change" | "external_integration" | "cost_increase"; target: string; payload: Record<string, unknown> }): Promise<{ approvalId: string }> {
  const task = await currentTask(env, call);
  if (!(await moveNode(env.DB, task, "waiting_owner", call.now))) throw new AppError("conflict", "タスクが変わった");
  const id = newId(clockAt(call.now));
  await drizzle(env.DB)
    .insert(approvals)
    .values({ id, kind: approval.kind, target: approval.target, payload: { ...approval.payload, nodeId: task.id }, status: "pending", requestedBy: call.staffId, requestedAt: call.now });
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "waiting_owner", detail: { approvalId: id, kind: approval.kind } }, actorOf(call));
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "approval.request", target: id, scope: task.scope, detail: { kind: approval.kind, target: approval.target }, traceId: call.traceId });
  // 答えを待つ間は次のタスクを進める
  await leaveTask(env, call.staffId, "handed_back", call.now);
  return { approvalId: id };
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
 * @returns 承認の ID
 */
function staffRequest(env: Bindings, _forge: Forge, call: ToolCall, input: StaffRequestTool): Promise<{ approvalId: string }> {
  return waitOwner(env, call, { kind: input.kind, target: input.kind === "staff_add" ? input.role : input.target, payload: { ...input } });
}

/**
 * 費用が増える事か新しい外部連携をオーナーに上げる
 * @param env バインディング
 * @param _forge 使わない
 * @param call 呼び出し
 * @param input AskOwnerTool
 * @returns 承認の ID
 */
function askOwner(env: Bindings, _forge: Forge, call: ToolCall, input: AskOwnerTool): Promise<{ approvalId: string }> {
  return waitOwner(env, call, { kind: input.kind, target: input.target, payload: { reason: input.reason } });
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
 */
async function prOpen(env: Bindings, forge: Forge, call: ToolCall, input: PrOpenTool): Promise<{ number: number; branch: string }> {
  const task = await currentTask(env, call);
  if (task.repo === null) throw new AppError("conflict", "タスクに直すリポジトリが無い");
  // レビューを割り振れないなら、GitHub に出す前に断る
  await checkPair(env.DB, call.staffId, REVIEWER);
  const branch = `ko/${task.id.slice(0, 8)}-${input.name}`;
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
  // TODO(#54): プルリクエストを出した事を guard.observe に渡す
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
 * 承認されたタスクを done にしてから main に入れる。入れられなければ review に戻す
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param review レビューのタスク
 * @param now 今の時刻
 * @throws conflict 確かめたタスクが読んだ後に変わった時
 */
async function mergeMade(env: Bindings, forge: Forge, made: NodeRow, review: { repo: string; branch: string }, now: number): Promise<void> {
  // 先に done にして、同じタスクを 2 度入れない
  const done = await moveNode(env.DB, made, "done", now);
  if (!done) throw new AppError("conflict", "確かめるタスクが変わった");
  try {
    await forge.merge(review.repo, review.branch);
  } catch (error) {
    await revertNode(env.DB, made.id, "done", "review", now);
    throw error;
  }
  // TODO(#54): main に入れた事を guard.observe に渡す
}

/**
 * レビュー担当が今のレビューのタスクに承認か差し戻しを出す。差し戻しは理由と一緒に作った社員のタスクに戻し、承認はチェックが通っていれば main に入れる
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼び出し
 * @param input ReviewSubmitTool
 * @returns main に入れたか
 * @throws conflict 今のタスクがレビューでない時、確かめるタスクが無いか review でない時、確かめるタスクが読んだ後に変わった時
 */
async function reviewSubmit(env: Bindings, forge: Forge, call: ToolCall, input: ReviewSubmitTool): Promise<{ merged: boolean }> {
  const review = await currentTask(env, call);
  if (review.taskKind !== "review" || review.repo === null || review.prNumber === null || review.branch === null) throw new AppError("conflict", "今のタスクはレビューでない");
  const orm = drizzle(env.DB);
  const [made] = await orm
    .select()
    .from(nodes)
    .where(and(eq(nodes.repo, review.repo), eq(nodes.prNumber, review.prNumber), ne(nodes.taskKind, "review")))
    .limit(1);
  if (!made) throw new AppError("conflict", "確かめるタスクが無い");
  // 見送られたタスクや、もう入れたタスクを main に入れない
  if (made.status !== "review") throw new AppError("conflict", "確かめるタスクがレビューを待っていない");
  const actor = actorOf(call);
  let merged = false;
  if (input.verdict === "reject") {
    if (!(await moveNode(env.DB, made, "todo", call.now))) throw new AppError("conflict", "確かめるタスクが変わった");
    await appendNodeEvent(env, { nodeId: made.id, staffId: call.staffId, kind: "review_rejected", detail: { summary: input.summary } }, actor);
  } else {
    // main に入れる条件はチェックとレビュー担当の承認 (タスクとレビューの 3.4 の初期値)。チェックが分からない時は入れない
    merged = await forge.checksPassed(review.repo, review.prNumber);
    if (merged) await mergeMade(env, forge, made, { repo: review.repo, branch: review.branch }, call.now);
    await appendNodeEvent(env, { nodeId: made.id, staffId: call.staffId, kind: "review_approved", detail: { summary: input.summary } }, actor);
    if (merged) await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "merged", detail: { branch: review.branch } }, actor);
    else await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "merge_waiting", detail: { reason: "checks" } }, actor);
  }
  await orm.update(reviews).set({ reviewerVerdict: input.verdict, reviewerSummary: input.summary }).where(eq(reviews.nodeId, made.id));
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "review.submit", target: made.id, scope: made.scope, detail: { verdict: input.verdict, merged }, traceId: call.traceId });
  await finishTask(env, call.staffId, review.id, call.now);
  if (input.verdict === "reject" && made.assignee !== null) await notifyStaff(env, made.assignee, call.now, false);
  return { merged };
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
};

/**
 * 社員のツールを 1 回動かす。`POST /ws/v1/tools/{toolName}` が作業トークンと判断を確かめた後に呼ぶ
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param call 呼び出し
 * @returns 社員に返す答え。中身は JSON の文字列
 * @throws not_found その社員の役では使えないツールの時
 * @throws validation_failed 入力がツールの形に合わない時
 * @throws conflict 今のタスクが無いなど、今の状態では動かせない時
 */
export async function runTool(env: Bindings, forge: Forge, call: ToolCall): Promise<ToolResult> {
  const tool = ROLE_TOOLS[call.staffId].includes(call.tool) ? TOOLS[call.tool] : undefined;
  if (!tool) throw new AppError("not_found", "この社員の役では使えないツール");
  const input = tool.schema.safeParse(call.input);
  if (!input.success) throw new AppError("validation_failed", "ツールの入力の形が違う");
  // 入力は上でツールごとのスキーマに通した物なので、そのツールの中身に渡せる
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const result = await tool.run(env, forge, call, input.data as never);
  return { content: JSON.stringify(result), isError: false };
}
