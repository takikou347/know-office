// 開発担当の pr_open の中身。PR を出し、タスクをレビューに移してレビュー担当に渡す。PR を持つタスクの 2 度目は新しい PR を出さず、先を読み直して出し直す (タスクとレビューの 3.1、開発の回し方の 3.5)
import { AppError, newId, type PrOpenTool, recordedText, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { reviews } from "../db/main.ts";
import { assertDocsPr } from "../devloop/docs-pr.ts";
import { childOf, missingTests, readPrFiles, type PrFiles, testsError, withCloses } from "../devloop/pr-issue.ts";
import type { Bindings } from "../env.ts";
import { repoScope } from "../github/rules.ts";
import { type GuardDeps, UNCONNECTED_DEPS } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { auditFrom } from "../ledger/record.ts";
import { clockAt } from "./attendance.ts";
import { type Forge, leaveTask, notifyStaff } from "./loop.ts";
import { appendNodeEvent, checkPair, createNode, findNode, moveNode, type NodeRow } from "./nodes.ts";
import { findReview, repoRefusal } from "./review.ts";

/** レビューのタスクを割り振る社員 */
const REVIEWER: StaffId = "reviewer";

/** pr_open を呼んだ社員と時刻 */
export type PrCall = { staffId: StaffId; now: number; traceId?: string | undefined; guard?: GuardDeps | undefined };

/**
 * 出す前に、ルールと設計書の形と子 Issue のテストの確かめを通す。変えたファイルは子のタスクだけ固定した先で 1 回読み、ルールとテストの確かめの両方に使う
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task 出すタスク
 * @param branch ブランチ
 * @returns 確かめた先。ブランチの先を固定した時はそのコミット、そうでなければブランチの名前
 * @throws rule_denied ルールの外の時
 * @throws validation_failed 設計書の形が違う時、bug と feature の子がテストのファイルを変えていない時
 * @throws upstream_failed 設計書の木を読み切れない時、GitHub から読めない時
 */
async function guardPr(env: Bindings, forge: Forge, call: PrCall, task: NodeRow & { repo: string }, branch: string): Promise<string> {
  const docs = (await repoScope(env.DB, task.repo)).docs;
  const child = await childOf(env.DB, task);
  // 設計書と子のタスクは、ブランチの先を 1 つのコミットに固定し、変えたファイルと形の確かめを同じコミットで読む
  const head = docs || child !== null ? await forge.branchHead(task.repo, branch) : branch;
  let found: PrFiles | null = null;
  if (child !== null) found = await readPrFiles(forge, task.repo, head);
  const refusal = await repoRefusal(env, forge, { action: "pull_request", repo: task.repo, branch: head, ...(found === null || found.truncated ? {} : { paths: found.paths }) });
  if (refusal !== null) {
    // ルールの外の操作として数える。触れない所に当たった時は、そのファイルへの書き込みとして数える
    const op = refusal.path === undefined ? { operation: "office.tool" as const, target: `${task.repo} pull_request` } : { operation: "file.write" as const, target: `${task.repo}/${refusal.path}` };
    await observe(env, { type: "rule_denied", staffId: call.staffId, nodeId: task.id, operation: op.operation, target: recordedText(op.target) }, call.now, call.guard ?? UNCONNECTED_DEPS, call.traceId);
    throw new AppError("rule_denied", refusal.reason);
  }
  // 形の外れた設計書と、別のサービスの置き場を変える設計書のタスクは、GitHub に PR を出す前に断る
  if (docs) await assertDocsPr(env.DB, forge, task, head);
  if (child !== null && found !== null) {
    const missing = missingTests(child, found);
    if (missing !== null) throw testsError(missing);
  }
  return head;
}

/**
 * タスクを review に移し、レビューの行を足すか直し、レビュー担当にレビューのタスクを足して、社員を次のタスクへ離す
 * @param env バインディング
 * @param call 呼んだ社員と時刻
 * @param task 出すタスク
 * @param pr ブランチ、PR の番号と、レビューの行の先。first なら行を足し、でなければ先を直す
 * @param pr.branch ブランチ
 * @param pr.number PR の番号
 * @param pr.baseSha main の先
 * @param pr.headSha ブランチの先
 * @param pr.first 初めて出す時 true
 * @throws conflict 出す間にタスクの担当か状態が変わった時
 */
async function hand(env: Bindings, call: PrCall, task: NodeRow & { repo: string }, pr: { branch: string; number: number; baseSha: string; headSha: string; first: boolean }): Promise<void> {
  // 出す間にオーナーが名前などを直すとバージョンが進むので、読み直して、まだこの社員の作業中の時だけ移す
  const fresh = await findNode(env.DB, task.id);
  if (fresh.status !== "doing" || fresh.assignee !== call.staffId) throw new AppError("conflict", "タスクが変わった");
  const moved = await moveNode(env.DB, fresh, "review", call.now, { branch: pr.branch, prNumber: pr.number });
  if (!moved) throw new AppError("conflict", "タスクが変わった");
  if (pr.first) {
    await drizzle(env.DB)
      .insert(reviews)
      .values({ id: newId(clockAt(call.now)), nodeId: task.id, repo: task.repo, prNumber: pr.number, branch: pr.branch, baseSha: pr.baseSha, headSha: pr.headSha });
  } else {
    // 先が変わった時だけ前の先の承認とチェックを消す。push の通知 (synchronize) と同じ式
    await env.DB.prepare(
      "UPDATE reviews SET owner_verdict = CASE WHEN head_sha = ?1 THEN owner_verdict ELSE NULL END, reviewer_verdict = CASE WHEN head_sha = ?1 THEN reviewer_verdict ELSE NULL END, checks = CASE WHEN head_sha = ?1 THEN checks ELSE '[]' END, head_sha = ?1 WHERE node_id = ?2",
    )
      .bind(pr.headSha, task.id)
      .run();
  }
  const actor = { by: call.staffId, now: call.now, traceId: call.traceId };
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "pr_opened", detail: { prNumber: pr.number, branch: pr.branch, ...(pr.first ? {} : { again: true }) } }, actor);
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "pull_request.open", target: task.id, scope: task.scope, detail: { repo: task.repo, prNumber: pr.number, again: !pr.first }, traceId: call.traceId });
  await createNode(
    env,
    { kind: "task", parentId: moved.parentId ?? undefined, scope: moved.scope, title: `レビュー: ${moved.title}`, taskKind: "review", assignee: REVIEWER, repo: task.repo, branch: pr.branch, prNumber: pr.number, source: "review", priority: moved.priority },
    { by: "system", now: call.now, traceId: call.traceId },
  );
  await leaveTask(env, call.staffId, "done", call.now);
  await notifyStaff(env, REVIEWER, call.now, false);
}

/**
 * 開発担当が今のタスクのブランチから PR を出す。タスクはレビューを待ち、レビュー担当にレビューのタスクを足す。
 * 子 Issue のタスクは、本文の最後にゲートウェイが Closes を付ける。PR を持つタスク (差し戻しや main の進みで戻ったタスク) は新しい PR を出さず、PR の今の先を読み直して出し直す
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task 今のタスク
 * @param input PrOpenTool
 * @returns PR の番号とブランチ
 * @throws conflict 直すリポジトリが無い時、レビュー担当が作った社員と同じモデルの時、出す間にタスクの担当か状態が変わった時
 * @throws rule_denied ルールの外の時
 * @throws validation_failed 設計書の形が違う時、bug と feature の子がテストのファイルを変えていない時
 * @throws upstream_failed 設計書の木を読み切れない時、GitHub から読めない時
 */
export async function openPr(env: Bindings, forge: Forge, call: PrCall, task: NodeRow, input: PrOpenTool): Promise<{ number: number; branch: string }> {
  if (task.repo === null) throw new AppError("conflict", "タスクに直すリポジトリが無い");
  const own = { ...task, repo: task.repo };
  // レビューを割り振れないなら、GitHub に出す前に断る
  await checkPair(env.DB, call.staffId, REVIEWER);
  if (task.prNumber !== null) {
    // 出し直し。別の name でも、PR は最初のブランチの 1 本だけ
    const review = await findReview(env.DB, task.id);
    const head = await guardPr(env, forge, call, own, review.branch);
    await hand(env, call, own, { branch: review.branch, number: review.prNumber, baseSha: review.baseSha, headSha: head, first: false });
    return { number: review.prNumber, branch: review.branch };
  }
  const branch = `ko/${task.id.slice(0, 8)}-${input.name}`;
  await guardPr(env, forge, call, own, branch);
  const child = await childOf(env.DB, task);
  const pr = await forge.openPull({ repo: task.repo, branch, title: input.title, body: child === null ? input.body : withCloses(input.body, child.number) });
  await hand(env, call, own, { branch, number: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, first: true });
  return { number: pr.number, branch };
}
