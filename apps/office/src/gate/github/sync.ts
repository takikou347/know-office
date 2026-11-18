// プルリクエストの先が進んだ通知 (synchronize) を写す。先を進めて承認を消し、レビュー担当にもう一度確かめさせる (GitHub の連携の 3.3、3.4)
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { sql } from "drizzle-orm";
import type { Bindings } from "../env.ts";
import type { Actor } from "../work/nodes.ts";
import { askReview, madeTaskOf, reviewAsked } from "../work/review.ts";
import { docsSynchronized } from "./hooks-docs.ts";

/**
 * 先が進んだ通知を写す。先を進めて前の先に出た承認とチェックを消す事、結んだ設計書の PR なら設計書の側の先を直して承認を消す事、レビュー担当のレビューのタスクを立て直す事、受けた記録を 1 回のバッチで書く
 * 同じ本文の通知を受けた後と、同じ先の通知がもう一度届いた時と、出し直しの pr_open が先に同じ先を写した時は何も直さない
 * @param env バインディング
 * @param pull 通知の中身
 * @param pull.repo リポジトリ
 * @param pull.number プルリクエストの番号
 * @param pull.headSha 新しい先
 * @param pull.digest 本文の SHA-256。同じ本文の通知を 2 度写さない
 * @param pull.now 受けた時刻
 * @param record 受けた記録を書く文
 */
export async function synchronize(env: Bindings, pull: { repo: string; number: number; headSha: string; digest: string; now: number }, record: D1PreparedStatement): Promise<void> {
  const db = env.DB;
  const fresh = "NOT EXISTS (SELECT 1 FROM github_deliveries WHERE body_sha256 = ?)";
  // 前の先に出た承認は新しい先を確かめていないので、同じ文で消して待ち直す。同じ先の通知がもう一度届いた時は消さない
  const update = db
    .prepare(`UPDATE reviews SET owner_verdict = NULL, reviewer_verdict = NULL, head_sha = ?, checks = '[]' WHERE repo = ? AND pr_number = ? AND head_sha <> ? AND ${fresh}`)
    .bind(pull.headSha, pull.repo, pull.number, pull.headSha, pull.digest);
  const made = await madeTaskOf(db, pull.repo, pull.number);
  const review = made === null ? null : await db.prepare("SELECT branch FROM reviews WHERE node_id = ?").bind(made.id).first<{ branch: string }>();
  const actor: Actor = { by: "system", now: pull.now };
  // 先を進める文が動いた時だけ求めるよう、進んだ先の承認が消えたままの時に限る。pr_open が先に同じ先を写して承認まで済んだ後の通知では立てない
  // 受けた記録を書くと同じ本文の条件が偽になるので、記録より前に置く
  const asked =
    made && review
      ? await askReview(
          env,
          made,
          { repo: pull.repo, branch: review.branch, prNumber: pull.number },
          actor,
          sql`EXISTS (SELECT 1 FROM reviews WHERE repo = ${pull.repo} AND pr_number = ${pull.number} AND head_sha = ${pull.headSha} AND reviewer_verdict IS NULL AND owner_verdict IS NULL) AND NOT EXISTS (SELECT 1 FROM github_deliveries WHERE body_sha256 = ${pull.digest})`,
        )
      : null;
  // 結んだ設計書の PR への push なら、設計書の側の先を直して承認を消す
  const docs = docsSynchronized(db, { repo: pull.repo, number: pull.number, sha: pull.headSha, digest: pull.digest });
  const results = await db.batch([update, docs, ...(asked ? [asked.statement] : []), record]);
  await reviewAsked(env, asked, results[2], actor);
}
