// レビューを読む道。ワークスペースを起こさず、ゲートウェイが GitHub の compare とファイルの API から取り、前に見た所からの差と読んだ所の印を持つ (API の reviews、タスクとレビューの 3.6)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, FileContent, FileDiff, languageOfPath, ReviewDiffQuery, ReviewFileQuery, ReviewHead, SeenInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { okResponse, problems } from "../openapi.ts";
import { noContent, ok } from "../respond.ts";
import type { ChangedFile, Forge } from "../work/loop.ts";
import { findReview, type ReviewRow } from "../work/review.ts";

const router = createRouter();

const NodeParam = z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict();

/** D1 の checks の列。通知が書いた物だが、読む時も形を確かめる */
const Checks = z.array(z.object({ name: z.string(), ok: z.boolean() }).strict()).catch([]);

/**
 * 統一形式の差分の本文を、塊ごとの行に分ける。行の頭が ` `、`+`、`-` の行だけを残し、`\ No newline at end of file` などの知らせは落とす
 * @param patch GitHub の compare が返した差分の本文
 * @returns 塊の並び
 */
export function hunksOf(patch: string): FileDiff["hunks"] {
  const hunks: FileDiff["hunks"] = [];
  for (const line of patch.split("\n")) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) hunks.push({ oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] });
    else if (/^[ +-]/.test(line)) hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

/**
 * 変わったファイルの並びから、道か前の道が合う物を探す
 * @param files 変わったファイル
 * @param path 探す道
 * @returns 合うファイル。無ければ undefined
 */
function fileAt(files: readonly ChangedFile[], path: string): ChangedFile | undefined {
  return files.find((f) => f.path === path || f.previousPath === path);
}

/**
 * 前に見た先から変わったファイルの道を返す。今の先まで読んでいれば空、まだ読んでいないか、compare が 300 件で切れて分からなければ all
 * @param forge GitHub
 * @param review レビューの行
 * @returns 未読の道か all
 * @throws upstream_failed GitHub から読めない時
 */
async function unreadPaths(forge: Forge, review: ReviewRow): Promise<Set<string> | "all"> {
  const since = review.lastSeenSha;
  if (since === null) return "all";
  if (since === review.headSha) return new Set();
  const compared = await forge.compare(review.repo, since, review.headSha);
  // 切れているかもしれない時は、読んだと言えないので全部を未読にする
  if (compared.truncated) return "all";
  return new Set(compared.files.flatMap((f) => [f.path, ...(f.previousPath === undefined ? [] : [f.previousPath])]));
}

/**
 * 差分を取る元のファイルの並びを返す。since が無ければプルリクエストのファイルの一覧、あればそこからの compare
 * @param forge GitHub
 * @param review レビューの行
 * @param since 前に見た先
 * @returns 変わったファイル
 * @throws upstream_failed GitHub から読めない時、compare が 300 件で切れて差を読み切れない時
 */
async function diffFiles(forge: Forge, review: ReviewRow, since: string | undefined): Promise<ChangedFile[]> {
  if (since === undefined) return forge.pullFiles(review.repo, review.prNumber);
  const compared = await forge.compare(review.repo, since, review.headSha);
  if (compared.truncated) throw new AppError("upstream_failed", "前に見た所からの差が多すぎて読み切れない");
  return compared.files;
}

const getReviewRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}",
  operationId: "getReview",
  tags: ["reviews"],
  summary: "レビューの概要",
  description: "レビュー担当の要約、チェック結果、変更ファイルのツリー。",
  "x-steps": [
    "`reviews` を取得する",
    "プルリクエストのファイルの一覧 API を 100 件ずつのページで読み、変更ファイルの一覧を取得する。30 ページ目まで満ちていれば 502。ワークスペースは起こさない",
    "`last_seen_sha` が今の `head_sha` と違えば、そこから `head_sha` までの compare に入るファイルを未読にする。compare が 300 件ちょうどで切れているかもしれない時は、全部を未読にする",
  ],
  "x-errors": ["404 `not_found`: レビューが存在しない", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した"],
  request: { params: NodeParam },
  responses: { 200: okResponse(ReviewHead), ...problems(401, 403, 404, 429, 500, 502) },
});

const getReviewDiffRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/diff",
  operationId: "getReviewDiff",
  tags: ["reviews"],
  summary: "1 ファイルの差分",
  description: "since を指定すると、前回確認した時点からの差分を返す。",
  "x-steps": [
    "`since` が無ければプルリクエストのファイルの一覧 API から、あれば `since` から `head_sha` までの compare API から、1 ファイル分の差分を取り出す。compare が 300 件ちょうどなら 502。ワークスペースは起こさない",
  ],
  "x-errors": ["404 `not_found`: ファイルが存在しない", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した"],
  request: { params: NodeParam, query: ReviewDiffQuery },
  responses: { 200: okResponse(FileDiff), ...problems(400, 401, 403, 404, 422, 429, 500, 502) },
});

const getReviewFileRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/file",
  operationId: "getReviewFile",
  tags: ["reviews"],
  summary: "変更前または変更後のファイル内容",
  "x-steps": ["変更前または変更後のファイル内容を contents API から取得する"],
  "x-errors": ["404 `not_found`: ファイルが存在しない", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した"],
  request: { params: NodeParam, query: ReviewFileQuery },
  responses: { 200: okResponse(FileContent), ...problems(400, 401, 403, 404, 422, 429, 500, 502) },
});

const markReviewSeenRoute = createRoute({
  method: "put",
  path: "/api/v1/reviews/{nodeId}/seen",
  operationId: "markReviewSeen",
  tags: ["reviews"],
  summary: "確認済みの位置を記録する",
  "x-steps": ["`sha` が現在の `head_sha` と一致する時だけ、`reviews.last_seen_sha` を `sha` にする。1 文の条件付きの `UPDATE` で書く"],
  "x-errors": ["404 `not_found`: レビューが存在しない", "409 `conflict`: 確認した後に変更が追加された"],
  request: { params: NodeParam, body: { content: { "application/json": { schema: SeenInput } }, required: true } },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** レビューを読むルート */
export const reviewReadRoutes = router
  .openapi(getReviewRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const review = await findReview(c.env.DB, nodeId);
    const files = await c.var.forge.pullFiles(review.repo, review.prNumber);
    const unread = await unreadPaths(c.var.forge, review);
    const seen = (f: ChangedFile) => unread !== "all" && !unread.has(f.path);
    return ok(c, {
      nodeId,
      repo: review.repo,
      prNumber: review.prNumber,
      branch: review.branch,
      baseSha: review.baseSha,
      headSha: review.headSha,
      lastSeenSha: review.lastSeenSha,
      checks: Checks.parse(review.checks),
      reviewerSummary: review.reviewerSummary ?? "",
      reviewerVerdict: review.reviewerVerdict,
      files: files.map((f) => ({ path: f.path, status: f.status, seen: seen(f) })),
    });
  })
  .openapi(getReviewDiffRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const query = c.req.valid("query");
    const review = await findReview(c.env.DB, nodeId);
    const file = fileAt(await diffFiles(c.var.forge, review, query.since), query.path);
    if (!file) throw new AppError("not_found", "このファイルは変わっていない");
    return ok(c, { path: file.path, language: languageOfPath(file.path), hunks: hunksOf(file.patch ?? "") });
  })
  .openapi(getReviewFileRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const query = c.req.valid("query");
    const review = await findReview(c.env.DB, nodeId);
    const ref = query.ref === "base" ? review.baseSha : review.headSha;
    const content = await c.var.forge.readFile(review.repo, ref, query.path);
    if (content === null) throw new AppError("not_found", "ファイルが無い");
    return ok(c, { path: query.path, ref, content });
  })
  .openapi(markReviewSeenRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const { sha } = c.req.valid("json");
    // 読んだ先がまだ今の先の時だけ、1 文で印を置く。間に push が届いていれば置かない
    const res = await c.env.DB.prepare("UPDATE reviews SET last_seen_sha = ? WHERE node_id = ? AND head_sha = ?").bind(sha, nodeId, sha).run();
    if (res.meta.changes === 0) {
      await findReview(c.env.DB, nodeId);
      throw new AppError("conflict", "読んだ後に変更が足された");
    }
    return noContent(c);
  });
