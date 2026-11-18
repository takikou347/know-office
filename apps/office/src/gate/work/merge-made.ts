// 承認されたタスクを done にしてから main を進める (タスクとレビューの 3.1 の 5)。子 Issue のタスクは閉じる順番待ちも同じバッチで積み、設計書の PR を結んだタスクは設計書を先に進める (開発の回し方の 3.6)
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError, newId } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { reviews } from "../db/main.ts";
import { childOf } from "../devloop/pr-issue.ts";
import type { Bindings } from "../env.ts";
import { enqueueMirror, sendMirror } from "../github/mirror.ts";
import { recordError } from "../ledger/errors.ts";
import { announceNotice } from "../live/publish.ts";
import { clockAt } from "./attendance.ts";
import { type DocsTarget, type Landed, landBoth, type Rehash, rehashFor } from "./docs-merge.ts";
import type { Forge } from "./loop.ts";
import type { NodeRow } from "./nodes.ts";
import { wakeWaiting } from "./wake.ts";

/** 設計書だけが入った時の知らせの文。社員の書いた文は入れない */
const SPLIT_BODY = "設計書の PR は main に入ったが、コードの PR は入らなかった。コードは作った社員が確かめ直して入れる";

/**
 * 承認されたタスクを done にしてから、main を確かめたコミットまで進める。入れられなければ review に戻し、main が先に進んでいて進められない時は作った社員に todo で戻す
 * 子 Issue のタスクは、done にする文と同じバッチで、入った後に Issue を閉じる順番待ちと、子の要件のハッシュを入れる設計書に合わせる文も積む。main に入らなければ、積んだ行を消して戻す
 * 設計書の PR を結んだタスクは、設計書を先に進める。設計書だけが入ってコードが進められなければ、設計書は残し、通知 devloop_split を出して戻す (behind は todo、ほかは review)
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param review リポジトリ、ブランチ、確かめたコミット、進める設計書
 * @param review.repo リポジトリ
 * @param review.branch ブランチ
 * @param review.sha mergeGate が確かめたコミット
 * @param review.docs 結んだ設計書の PR。結んでいなければ無い。確かめた先がもう main に入っていれば landed で、進めるのはコードだけ
 * @param now 今の時刻
 * @returns main に入れたら merged、何も進めずに戻したら behind (遅れたリポジトリ付き)、設計書だけ入れたら split (失敗の種類付き)
 * @throws conflict 確かめたタスクが読んだ後に変わった時
 * @throws not_found 子 Issue のタスクのレビューが無い時 (done にする前に断る)
 * @throws upstream_failed GitHub が main を進める更新を断った時 (main が先に進んだ時と、設計書の後のコードの失敗を除く)
 */
export async function mergeMade(env: Bindings, forge: Forge, made: NodeRow, review: { repo: string; branch: string; sha: string; docs?: DocsTarget | undefined }, now: number): Promise<Landed> {
  // 先に done にして、同じタスクを 2 度入れない。子 Issue のタスクは、同じバッチで閉じる順番待ちと要件のハッシュも書く
  const child = await childOf(env.DB, made);
  const rehash = review.docs === undefined ? null : await rehashFor(env.DB, forge, made, review.docs);
  let closeId: string | null = null;
  // done にする文と同じバッチで、入れ始めた印と入れる先のコミットを reviews に書く。止まった入れ直しだけを定期の確かめ (resumeMerges) が拾えるようにする
  const statements = [env.DB.prepare("UPDATE nodes SET status = 'done', version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(now, made.id, made.version)];
  statements.push(
    env.DB.prepare(
      "UPDATE reviews SET merge_started_at = ?, merge_started_sha = ?, merge_tries = 0, merge_retry_at = NULL WHERE node_id = ? AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND version = ? AND status = 'done')",
    ).bind(now, review.sha, made.id, made.id, made.version + 1),
  );
  if (child !== null) {
    const [row] = await drizzle(env.DB).select({ id: reviews.id }).from(reviews).where(eq(reviews.nodeId, made.id)).limit(1);
    if (!row) throw new AppError("not_found", "レビューが無い");
    const close = enqueueMirror(env, row.id, { kind: "issue_close", payload: { issueNumber: child.number, sha: review.sha } }, clockAt(now), {
      sql: "EXISTS (SELECT 1 FROM nodes WHERE id = ? AND version = ? AND status = 'done')",
      args: [made.id, made.version + 1],
    });
    statements.push(close.statement);
    // 要件のハッシュを直す文は、このタスクが done になっている時だけ書く (rehashFor の条件)。負けた側は書かない
    if (rehash !== null) statements.push(rehash.apply);
    closeId = close.id;
  }
  const [done] = await env.DB.batch(statements);
  if ((done?.meta.changes ?? 0) === 0) throw new AppError("conflict", "確かめるタスクが変わった");
  let outcome: Landed;
  try {
    outcome = review.docs === undefined || review.docs.landed === true ? await mergeCode(forge, review) : await landBoth(forge, review, review.docs);
  } catch (error) {
    await undoMerge(env, made.id, "review", closeId, now, rehash);
    throw error;
  }
  if (typeof outcome === "object" && "behind" in outcome) {
    // main が先に進んでいる。何も進めていないので、作った社員に戻して rebase させる。積んだ閉じと要件のハッシュは、タスクを戻す文と同じバッチで戻す
    await undoMerge(env, made.id, "todo", closeId, now, rehash);
    return outcome;
  }
  if (typeof outcome === "object") {
    // 設計書は main に入った。要件のハッシュは設計書に合わせたままにする (戻すと合わせ直しが子を作り直す)
    await splitMerge(env, made, outcome, closeId, now);
    return outcome;
  }
  // 入れた印。書く前に止まっても、定期の確かめが main に入っている事を読んで書く (resumeMerges)
  await env.DB.prepare("UPDATE reviews SET merged_at = ? WHERE node_id = ? AND merged_at IS NULL")
    .bind(now, made.id)
    .run()
    .catch((error: unknown) => recordError(env, { source: "gate", level: "warn", code: "merged_mark_failed", error }, clockAt(now)));
  // 入った子と重なって待っていた子を、取らせる
  if (made.repo !== null) await wakeWaiting(env, made.repo, now);
  if (closeId !== null) await sendMirror(env, forge, closeId, clockAt(now));
  return "merged";
}

/**
 * コードだけを main へ進める
 * @param forge GitHub
 * @param code リポジトリ、ブランチ、確かめたコミット
 * @param code.repo リポジトリ
 * @param code.branch ブランチ
 * @param code.sha 確かめたコミット
 * @returns 進めたら merged、main が先に進んでいたら behind (リポジトリ付き)
 * @throws upstream_failed GitHub が断った時
 */
async function mergeCode(forge: Forge, code: { repo: string; branch: string; sha: string }): Promise<Landed> {
  return (await forge.merge(code.repo, { branch: code.branch, sha: code.sha })) === "behind" ? { behind: code.repo } : "merged";
}

/**
 * main に入れられなかったタスクを done から戻し、積んだ閉じの順番待ちを消し、要件のハッシュを元に戻す。同じバッチで書き、片方だけ残さない
 * @param env バインディング
 * @param nodeId タスク ID
 * @param to 戻す状態。入れられなかっただけなら review、main が進んでいたなら todo
 * @param closeId 積んだ閉じの順番待ちの ID。無ければ null
 * @param now 今の時刻
 * @param rehash 戻す要件のハッシュ。無ければ null
 */
async function undoMerge(env: Bindings, nodeId: string, to: "review" | "todo", closeId: string | null, now: number, rehash: Rehash | null): Promise<void> {
  const statements = [env.DB.prepare("UPDATE nodes SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'done'").bind(to, now, nodeId)];
  if (closeId !== null) statements.push(env.DB.prepare("DELETE FROM github_mirrors WHERE id = ? AND sent_at IS NULL").bind(closeId));
  if (rehash !== null) statements.push(rehash.revert);
  statements.push(env.DB.prepare("UPDATE reviews SET merge_started_at = NULL, merge_started_sha = NULL WHERE node_id = ?").bind(nodeId));
  await env.DB.batch(statements);
}

/**
 * 設計書だけが入った時に、タスクを done から戻し、通知 devloop_split を出し、積んだ閉じの順番待ちを消す。同じバッチで書き、通知はタスクを戻せた時だけ足す。通知は足せたら配り、失敗の種類をエラーログに残す
 * @param env バインディング
 * @param made 確かめたタスク
 * @param split 戻す先、失敗の種類、投げられた物
 * @param split.split 戻す先
 * @param split.error 投げられた物。遅れただけなら無い
 * @param closeId 積んだ閉じの順番待ちの ID。無ければ null
 * @param now 今の時刻
 */
async function splitMerge(env: Bindings, made: NodeRow, split: { split: "todo" | "review"; error?: unknown }, closeId: string | null, now: number): Promise<void> {
  const noticeId = newId(clockAt(now));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE nodes SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'done'").bind(split.split, now, made.id),
    // 直前の文が 1 行書いた時だけ足す
    env.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) SELECT ?, ?, 'warn', 'devloop_split', '設計書だけが main に入った', ?, ? WHERE changes() > 0").bind(noticeId, now, SPLIT_BODY, made.scope),
  ];
  if (closeId !== null) statements.push(env.DB.prepare("DELETE FROM github_mirrors WHERE id = ? AND sent_at IS NULL").bind(closeId));
  statements.push(env.DB.prepare("UPDATE reviews SET merge_started_at = NULL, merge_started_sha = NULL WHERE node_id = ?").bind(made.id));
  const [, notice] = await env.DB.batch(statements);
  if ((notice?.meta.changes ?? 0) > 0) await announceNotice(env, noticeId, clockAt(now));
  if (split.error !== undefined) await recordError(env, { source: "gate", level: "warn", code: "devloop_split", error: split.error }, clockAt(now));
}
