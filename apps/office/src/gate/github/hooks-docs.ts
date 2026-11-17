// 結んだ設計書の PR に push された通知の直し方。コードの PR の push (synchronize) と同じ式を、設計書の側の先 reviews.docs_head_sha に当てる (開発の回し方の 3.6)
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

/**
 * 設計書の PR は task_docs から (リポジトリ、番号) で引き、承認した設計書の先と違えば承認を消して先を直す文を作る。チェックはコードの先の物なので、触らない。同じ先の通知の受け直しは消さない。同じ本文の通知をまだ受けていない時だけ書く
 * @param db 今の状態の D1
 * @param push 通知のリポジトリ、PR の番号、新しい先、本文の SHA-256
 * @param push.repo リポジトリ
 * @param push.number PR の番号
 * @param push.sha 新しい先
 * @param push.digest 通知の本文の SHA-256
 * @returns 直す文
 */
export function docsSynchronized(db: D1Database, push: { repo: string; number: number; sha: string; digest: string }): D1PreparedStatement {
  const same = "docs_head_sha IS ?1";
  return db
    .prepare(
      `UPDATE reviews SET owner_verdict = CASE WHEN ${same} THEN owner_verdict ELSE NULL END, reviewer_verdict = CASE WHEN ${same} THEN reviewer_verdict ELSE NULL END, docs_head_sha = ?1 WHERE node_id IN (SELECT node_id FROM task_docs WHERE repo = ?2 AND pr_number = ?3) AND NOT EXISTS (SELECT 1 FROM github_deliveries WHERE body_sha256 = ?4)`,
    )
    .bind(push.sha, push.repo, push.number, push.digest);
}
