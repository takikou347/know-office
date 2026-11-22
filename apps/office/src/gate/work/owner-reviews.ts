// オーナーの判断を待つレビューを読む。main に入れる条件にオーナーの承認があり、レビュー担当が承認してオーナーを待つ物を、ダッシュボードの承認を待つ物に出す (タスクとレビューの 3.4、GitHub の連携の 3.3)
import { type OwnerReview, StaffId } from "@know-office/core";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import { nodes, reviews } from "../db/main.ts";
import { repoScope } from "../github/rules.ts";

/** オーナーの判断を待つレビューを 1 度に返す件数の上限。承認の一覧の limit の上限と同じ */
export const OWNER_REVIEWS_LIMIT = 100;

/**
 * レビュー担当が承認し、オーナーがまだ決めておらず、main に入れていない、レビューを待つタスクのレビューの条件
 * @returns 条件
 */
function waitingOwner(): SQL | undefined {
  return and(eq(reviews.reviewerVerdict, "approve"), isNull(reviews.ownerVerdict), isNull(reviews.mergedAt), isNull(reviews.mergeStartedAt), eq(nodes.status, "review"), eq(nodes.kind, "task"));
}

/**
 * オーナーの判断を待つレビューを古い順に読む。リポジトリごとに main に入れる条件 (サービスの設定か office の初期値) を読み、オーナーの承認がある所だけを返す
 * 守りのファイルを変える know-office 自身の PR と最初の設計書の PR は、変えたファイルを GitHub から読まないと分からないので、ここでは数えない
 * @param db 今の状態の D1
 * @param limit 返す件数の上限
 * @returns オーナーの判断を待つレビュー
 * @throws internal 置いた設定の形が違う時
 */
export async function ownerWaitingReviews(db: D1Database, limit = OWNER_REVIEWS_LIMIT): Promise<OwnerReview[]> {
  const orm = drizzle(db);
  const repos = await orm.selectDistinct({ repo: reviews.repo }).from(reviews).innerJoin(nodes, eq(nodes.id, reviews.nodeId)).where(waitingOwner());
  const scopes = await Promise.all(repos.map(async (r) => ({ repo: r.repo, when: (await repoScope(db, r.repo)).rules.mergeWhen })));
  const owned = scopes.filter((s) => s.when.includes("owner")).map((s) => s.repo);
  if (owned.length === 0) return [];
  const rows = await orm
    .select({ nodeId: nodes.id, title: nodes.title, assignee: nodes.assignee, repo: reviews.repo, prNumber: reviews.prNumber, updatedAt: nodes.updatedAt })
    .from(reviews)
    .innerJoin(nodes, eq(nodes.id, reviews.nodeId))
    .where(and(waitingOwner(), inArray(reviews.repo, owned)))
    .orderBy(asc(nodes.updatedAt), asc(reviews.id))
    .limit(limit);
  return rows.map((r) => {
    const assignee = StaffId.safeParse(r.assignee);
    return { nodeId: r.nodeId, title: r.title, assignee: assignee.success ? assignee.data : null, repo: r.repo, prNumber: r.prNumber, requestedAt: new Date(r.updatedAt).toISOString() };
  });
}
