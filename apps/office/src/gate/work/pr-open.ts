// 開発担当の pr_open の中身。プルリクエストを出すか、差し戻しや main の進みの後に同じプルリクエストで出し直し、レビュー担当にレビューのタスクを立てる (タスクとレビューの 3.1、開発の回し方の 3.5、3.6)
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError, type Clock, newId, type PrOpenTool } from "@know-office/core";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { reviews } from "../db/main.ts";
import { assertDocsPr } from "../devloop/docs-pr.ts";
import { type DocsRow, linkedRow } from "../devloop/docs-link.ts";
import { type ChildRef, childOf, missingTests, readPrFiles, type PrFiles, testsError, withCloses } from "../devloop/pr-issue.ts";
import type { Bindings } from "../env.ts";
import { repoScope } from "../github/rules.ts";
import { auditFrom } from "../ledger/record.ts";
import { clockAt } from "./attendance.ts";
import { type Forge, leaveTask } from "./loop.ts";
import { type Actor, appendNodeEvent, checkPair, findNode, type NodeRow } from "./nodes.ts";
import { guardDocsBranch } from "./docs-pr-open.ts";
import { askReview, REVIEWER, repoRefusal, reviewAsked } from "./review.ts";
import { denyByRule, type PrCall } from "./rule-denied.ts";

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
 * 開発担当が今のタスクのブランチからプルリクエストを出す。タスクはレビューを待ち、レビュー担当にレビューのタスクを足す
 * 差し戻しの後の出し直しは、開いていれば同じプルリクエストを使い、GitHub に書かない。閉じていれば新しいプルリクエストを出して同じレビューの行を直し、もう入っていれば断る
 * 子 Issue のタスクは、本文の最後にゲートウェイが Closes を付ける。タスクの移し、レビューの行、レビューのタスクは、タスクの版が読んだ時のままの時だけ 1 回のバッチで書く
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task 呼んだ社員の今のタスク
 * @param input PrOpenTool
 * @returns プルリクエストの番号とブランチ
 * @throws conflict 直すリポジトリが無い時、レビュー担当が作った社員と同じモデルの時、出す間にタスクの担当か状態が変わった時、プルリクエストがもう入った時
 * @throws rule_denied ルールがプルリクエストを出す事を断った時
 * @throws validation_failed 設計書の形が違う時、bug と feature の子がテストのファイルを変えていない時
 * @throws upstream_failed GitHub がプルリクエストを出せないか読めない時、設計書の木を読み切れない時
 */
export async function openPr(env: Bindings, forge: Forge, call: PrCall, task: NodeRow, input: PrOpenTool): Promise<{ number: number; branch: string }> {
  if (task.repo === null) throw new AppError("conflict", "タスクに直すリポジトリが無い");
  // レビューを割り振れないなら、GitHub に出す前に断る
  await checkPair(env.DB, call.staffId, REVIEWER);
  const [before] = await drizzle(env.DB).select().from(reviews).where(eq(reviews.nodeId, task.id)).limit(1);
  const branch = before?.branch ?? `ko/${task.id.slice(0, 8)}-${input.name}`;
  // 出し直しは、レビューの行に書く先を読むので、ブランチの先を必ず固定する
  const link = await linkedRow(env.DB, task.id, input.docsPr);
  const { head, child, docsHead } = await guardPr(env, forge, call, { ...task, repo: task.repo }, branch, before !== undefined, link);
  const docs = link === null || docsHead === null ? null : { link, headSha: docsHead };
  const text = { title: input.title, body: child === null ? input.body : withCloses(input.body, child.number) };
  const pull = await pullFor(forge, task.repo, branch, text, before === undefined ? undefined : { row: before, head });
  // 出す間にオーナーが名前などを直すとバージョンが進むので、読み直して、まだこの社員の作業中の時だけ移す
  const fresh = await findNode(env.DB, task.id);
  if (fresh.status !== "doing" || fresh.assignee !== call.staffId) throw new AppError("conflict", "タスクが変わった");
  const db = env.DB;
  const actor: Actor = { by: "system", now: call.now, traceId: call.traceId };
  // 移す文がこのバッチで書いた時だけ、ほかの文も書く。読んだ版が doing のままなら、版を 1 つ上げて review にしたのはこの移しだけ
  const movedSql = "EXISTS (SELECT 1 FROM nodes WHERE id = ? AND version = ? AND status = 'review')";
  const movedArgs = [task.id, fresh.version + 1];
  const move = db
    .prepare("UPDATE nodes SET status = 'review', branch = ?, pr_number = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'doing' AND assignee = ?")
    .bind(branch, pull.number, call.now, task.id, fresh.version, call.staffId);
  const made: NodeRow = { ...fresh, status: "review", branch, prNumber: pull.number };
  // 結んだ設計書の PR は、レビューのタスクの本文に書き、コードの PR と一緒に確かめさせる
  const docsBody = docs === null ? null : `設計書の PR: ${docs.link.repo} の ${docs.link.branch} (#${String(docs.link.prNumber)})。コードの PR と一緒に確かめる`;
  const asked = await askReview(env, made, { repo: task.repo, branch, prNumber: pull.number, body: docsBody }, actor, sql`EXISTS (SELECT 1 FROM nodes WHERE id = ${task.id} AND version = ${fresh.version + 1} AND status = 'review')`);
  const results = await db.batch([move, reviewStatement(db, { nodeId: task.id, repo: task.repo, branch, docsHeadSha: docs?.headSha ?? null }, pull, before, { sql: movedSql, args: movedArgs }, clockAt(call.now)), ...(asked ? [asked.statement] : [])]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw new AppError("conflict", "タスクが変わった");
  const again = before === undefined ? {} : { again: true };
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "pr_opened", detail: { prNumber: pull.number, branch, ...again, ...(docs === null ? {} : { docsPr: docs.link.prNumber }) } }, { by: call.staffId, now: call.now, traceId: call.traceId });
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "pull_request.open", target: task.id, scope: task.scope, detail: { repo: task.repo, prNumber: pull.number, ...again }, traceId: call.traceId });
  // TODO(#54): プルリクエストを出した事を guard.observe に渡す
  await reviewAsked(env, asked, results[2], actor);
  await leaveTask(env, call.staffId, "done", call.now);
  return { number: pull.number, branch };
}

/** 出すか使い直すプルリクエスト。opened は GitHub に新しく出した時に true */
type PullToUse = { number: number; baseSha: string; headSha: string; opened: boolean };

/**
 * 出し直しなら GitHub で今のプルリクエストを読み、開いていれば使い直し、閉じていれば新しく出す。初めてなら新しく出す
 * @param forge GitHub
 * @param repo リポジトリ
 * @param branch ブランチ
 * @param input 題と本文。子 Issue のタスクは Closes を付けた本文
 * @param again 出し直しの時の、前に出したレビューの行と、確かめた時に固定したブランチの先
 * @param again.row 前に出したレビューの行
 * @param again.head 固定したブランチの先
 * @returns 使うプルリクエスト
 * @throws conflict もう入った時
 * @throws upstream_failed GitHub がプルリクエストを出せないか、読めない時
 */
async function pullFor(forge: Forge, repo: string, branch: string, input: { title: string; body: string }, again: { row: typeof reviews.$inferSelect; head: string } | undefined): Promise<PullToUse> {
  if (again !== undefined) {
    const state = await forge.pullState(repo, again.row.prNumber);
    if (state.state === "merged") throw new AppError("conflict", "プルリクエストはもう入った");
    // ルールとテストを確かめた先をレビューの行に書く。確かめた後に進んだ先は synchronize の通知が写す
    if (state.state === "open") return { number: again.row.prNumber, baseSha: again.row.baseSha, headSha: again.head, opened: false };
  }
  const pr = await forge.openPull({ repo, branch, title: input.title, body: input.body });
  return { ...pr, opened: true };
}

/**
 * レビューの行を書く文を作る。初めてなら足し、出し直しで同じプルリクエストなら、読んだ先のままの時だけ先を写す。
 * コードか設計書のどちらかの先が変わった時は承認を消し、チェックはコードの先の物なのでコードの先が変わった時だけ消す。新しいプルリクエストなら番号から書き直す
 * @param db 今の状態の D1
 * @param row 書く行の中身
 * @param row.nodeId 作った社員のタスク ID
 * @param row.repo リポジトリ
 * @param row.branch ブランチ
 * @param row.docsHeadSha 結んだ設計書の PR の確かめた先。結んでいなければ null
 * @param pull 使うプルリクエスト
 * @param before 前に出したレビューの行
 * @param moved タスクを移せた時だけ書く条件
 * @param moved.sql 条件の SQL
 * @param moved.args 条件の値
 * @param clock ID を作る時刻
 * @returns 文
 */
function reviewStatement(
  db: D1Database,
  row: { nodeId: string; repo: string; branch: string; docsHeadSha: string | null },
  pull: PullToUse,
  before: typeof reviews.$inferSelect | undefined,
  moved: { sql: string; args: unknown[] },
  clock: Clock,
): D1PreparedStatement {
  if (before === undefined) {
    return db
      .prepare(`INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, docs_head_sha) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${moved.sql}`)
      .bind(newId(clock), row.nodeId, row.repo, pull.number, row.branch, pull.baseSha, pull.headSha, row.docsHeadSha, ...moved.args);
  }
  if (pull.opened) {
    return db
      .prepare(`UPDATE reviews SET pr_number = ?, branch = ?, base_sha = ?, head_sha = ?, docs_head_sha = ?, checks = '[]', owner_verdict = NULL, reviewer_verdict = NULL WHERE node_id = ? AND ${moved.sql}`)
      .bind(pull.number, row.branch, pull.baseSha, pull.headSha, row.docsHeadSha, row.nodeId, ...moved.args);
  }
  // 読んだ後に synchronize の通知が先を進めていれば、そちらが新しいので書かない
  const same = "head_sha = ? AND docs_head_sha IS ?";
  const sameArgs = [pull.headSha, row.docsHeadSha];
  return db
    .prepare(
      `UPDATE reviews SET checks = CASE WHEN head_sha = ? THEN checks ELSE '[]' END, owner_verdict = CASE WHEN ${same} THEN owner_verdict ELSE NULL END, reviewer_verdict = CASE WHEN ${same} THEN reviewer_verdict ELSE NULL END, head_sha = ?, docs_head_sha = ? WHERE node_id = ? AND head_sha = ? AND ${moved.sql}`,
    )
    .bind(pull.headSha, ...sameArgs, ...sameArgs, pull.headSha, row.docsHeadSha, row.nodeId, before.headSha, ...moved.args);
}
