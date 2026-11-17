// 開発担当の pr_open の中身。PR を出し、タスクをレビューに移してレビュー担当に渡す。PR を持つタスクの 2 度目は新しい PR を出さず、先を読み直して出し直す (タスクとレビューの 3.1、開発の回し方の 3.5)
import { AppError, newId, type PrOpenTool, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { reviews } from "../db/main.ts";
import { assertDocsPr } from "../devloop/docs-pr.ts";
import { type DocsRow, linkedRow } from "../devloop/docs-link.ts";
import { type ChildRef, childOf, missingTests, readPrFiles, type PrFiles, testsError, withCloses } from "../devloop/pr-issue.ts";
import type { Bindings } from "../env.ts";
import { repoScope } from "../github/rules.ts";
import { auditFrom } from "../ledger/record.ts";
import { clockAt } from "./attendance.ts";
import { type Forge, leaveTask, notifyStaff } from "./loop.ts";
import { appendNodeEvent, checkPair, createNode, findNode, moveNode, type NodeRow } from "./nodes.ts";
import { guardDocsBranch } from "./docs-pr-open.ts";
import { findReview, repoRefusal } from "./review.ts";
import { denyByRule, type PrCall } from "./rule-denied.ts";

/** レビューのタスクを割り振る社員 */
const REVIEWER: StaffId = "reviewer";

/**
 * 出す前に、ルールと設計書の形と子 Issue のテストの確かめを通す。変えたファイルは子のタスクだけ固定した先で 1 回読み、ルールとテストの確かめの両方に使う
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task 出すタスク
 * @param branch ブランチ
 * @param pin ブランチの先を必ず固定するか。出し直しは、レビューの行に書く先を読むので true
 * @param link 結ぶ設計書の PR の行。無ければ null
 * @returns 確かめた先 (ブランチの先を固定した時はそのコミット、そうでなければブランチの名前)、タスクの子 Issue、結んだ設計書の先
 * @throws rule_denied ルールの外の時
 * @throws validation_failed 設計書の形が違う時、bug と feature の子がテストのファイルを変えていない時
 * @throws upstream_failed 設計書の木を読み切れない時、GitHub から読めない時
 */
async function guardPr(env: Bindings, forge: Forge, call: PrCall, task: NodeRow & { repo: string }, branch: string, pin: boolean, link: DocsRow | null): Promise<{ head: string; child: ChildRef | null; docsHead: string | null }> {
  const docs = (await repoScope(env.DB, task.repo)).docs;
  const child = await childOf(env.DB, task);
  // 設計書と子のタスクは、ブランチの先を 1 つのコミットに固定し、変えたファイルと形の確かめを同じコミットで読む
  const head = pin || docs || child !== null ? await forge.branchHead(task.repo, branch) : branch;
  let found: PrFiles | null = null;
  if (child !== null) found = await readPrFiles(forge, task.repo, head);
  const refusal = await repoRefusal(env, forge, { action: "pull_request", repo: task.repo, branch: head, ...(found === null || found.truncated ? {} : { paths: found.paths }) });
  if (refusal !== null) {
    return denyByRule(env, call, task, refusal, task.repo);
  }
  // 形の外れた設計書と、別のサービスの置き場を変える設計書のタスクは、GitHub に PR を出す前に断る
  if (docs) await assertDocsPr(env.DB, forge, task, head);
  if (child !== null && found !== null) {
    const missing = missingTests(child, found);
    if (missing !== null) throw testsError(missing);
  }
  // 結んだ設計書の PR は、ブランチの先を固定して確かめる。もう main に入っていれば、先だけ読んで確かめない
  let docsHead: string | null = null;
  if (link !== null) {
    docsHead = await forge.branchHead(link.repo, link.branch);
    if (!(await forge.inMain(link.repo, docsHead))) docsHead = await guardDocsBranch(env, forge, call, task, link);
  }
  return { head, child, docsHead };
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
async function hand(env: Bindings, call: PrCall, task: NodeRow & { repo: string }, pr: { branch: string; number: number; baseSha: string; headSha: string; first: boolean; docs: { link: DocsRow; headSha: string } | null }): Promise<void> {
  // 出す間にオーナーが名前などを直すとバージョンが進むので、読み直して、まだこの社員の作業中の時だけ移す
  const fresh = await findNode(env.DB, task.id);
  if (fresh.status !== "doing" || fresh.assignee !== call.staffId) throw new AppError("conflict", "タスクが変わった");
  const moved = await moveNode(env.DB, fresh, "review", call.now, { branch: pr.branch, prNumber: pr.number });
  if (!moved) throw new AppError("conflict", "タスクが変わった");
  if (pr.first) {
    await drizzle(env.DB)
      .insert(reviews)
      .values({ id: newId(clockAt(call.now)), nodeId: task.id, repo: task.repo, prNumber: pr.number, branch: pr.branch, baseSha: pr.baseSha, headSha: pr.headSha, docsHeadSha: pr.docs?.headSha ?? null });
  } else {
    // コードか設計書のどちらかの先が変わった時だけ前の先の承認を消す。チェックはコードの先の物なので、コードの先が変わった時だけ消す。push の通知 (synchronize) と同じ式
    const same = "head_sha = ?1 AND docs_head_sha IS ?3";
    await env.DB.prepare(
      `UPDATE reviews SET owner_verdict = CASE WHEN ${same} THEN owner_verdict ELSE NULL END, reviewer_verdict = CASE WHEN ${same} THEN reviewer_verdict ELSE NULL END, checks = CASE WHEN head_sha = ?1 THEN checks ELSE '[]' END, head_sha = ?1, docs_head_sha = ?3 WHERE node_id = ?2`,
    )
      .bind(pr.headSha, task.id, pr.docs?.headSha ?? null)
      .run();
  }
  const actor = { by: call.staffId, now: call.now, traceId: call.traceId };
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "pr_opened", detail: { prNumber: pr.number, branch: pr.branch, ...(pr.first ? {} : { again: true }), ...(pr.docs === null ? {} : { docsPr: pr.docs.link.prNumber }) } }, actor);
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "pull_request.open", target: task.id, scope: task.scope, detail: { repo: task.repo, prNumber: pr.number, ...(pr.first ? {} : { again: true }) }, traceId: call.traceId });
  await createNode(
    env,
    { kind: "task", parentId: moved.parentId ?? undefined, scope: moved.scope, title: `レビュー: ${moved.title}`, ...(pr.docs === null ? {} : { body: `設計書の PR: ${pr.docs.link.repo} の ${pr.docs.link.branch} (#${String(pr.docs.link.prNumber)})。コードの PR と一緒に確かめる` }), taskKind: "review", assignee: REVIEWER, repo: task.repo, branch: pr.branch, prNumber: pr.number, source: "review", priority: moved.priority },
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
    const link = await linkedRow(env.DB, task.id, input.docsPr);
    const { head, docsHead } = await guardPr(env, forge, call, own, review.branch, true, link);
    await hand(env, call, own, { branch: review.branch, number: review.prNumber, baseSha: review.baseSha, headSha: head, first: false, docs: link === null || docsHead === null ? null : { link, headSha: docsHead } });
    return { number: review.prNumber, branch: review.branch };
  }
  const branch = `ko/${task.id.slice(0, 8)}-${input.name}`;
  const link = await linkedRow(env.DB, task.id, input.docsPr);
  const { child, docsHead } = await guardPr(env, forge, call, own, branch, false, link);
  const pr = await forge.openPull({ repo: task.repo, branch, title: input.title, body: child === null ? input.body : withCloses(input.body, child.number) });
  await hand(env, call, own, { branch, number: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, first: true, docs: link === null || docsHead === null ? null : { link, headSha: docsHead } });
  return { number: pr.number, branch };
}
