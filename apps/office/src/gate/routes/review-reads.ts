// レビューを読む道。ワークスペースを起こさず、ゲートウェイが GitHub の compare とファイルの API から取り、前に見た所からの差と読んだ所の印を持つ (ルートの一覧の 1.9、タスクとレビューの 3.6)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, FileContent, FileDiff, languageOfPath, ReviewDiffQuery, ReviewFileQuery, ReviewHead, SeenInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { okResponse, problems } from "../openapi.ts";
import { noContent, ok } from "../respond.ts";
import type { ChangedFile } from "../work/loop.ts";
import { findReview } from "../work/review.ts";

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

const getReviewRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}",
  operationId: "getReview",
  tags: ["reviews"],
  request: { params: NodeParam },
  responses: { 200: okResponse(ReviewHead), ...problems(401, 403, 404, 429, 500, 502) },
});

const getReviewDiffRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/diff",
  operationId: "getReviewDiff",
  tags: ["reviews"],
  request: { params: NodeParam, query: ReviewDiffQuery },
  responses: { 200: okResponse(FileDiff), ...problems(400, 401, 403, 404, 422, 429, 500, 502) },
});

const getReviewFileRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/file",
  operationId: "getReviewFile",
  tags: ["reviews"],
  request: { params: NodeParam, query: ReviewFileQuery },
  responses: { 200: okResponse(FileContent), ...problems(400, 401, 403, 404, 422, 429, 500, 502) },
});

const markReviewSeenRoute = createRoute({
  method: "put",
  path: "/api/v1/reviews/{nodeId}/seen",
  operationId: "markReviewSeen",
  tags: ["reviews"],
  request: { params: NodeParam, body: { content: { "application/json": { schema: SeenInput } }, required: true } },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** レビューを読むルート */
export const reviewReadRoutes = router
  .openapi(getReviewRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const review = await findReview(c.env.DB, nodeId);
    const files = await c.var.forge.compare(review.repo, review.baseSha, review.headSha);
    // 前に見た先から変わったファイルだけを、まだ読んでいない事にする。今の先まで読んでいれば GitHub に聞かない
    const since = review.lastSeenSha;
    const changed = since === null || since === review.headSha ? null : new Set((await c.var.forge.compare(review.repo, since, review.headSha)).flatMap((f) => [f.path, ...(f.previousPath === undefined ? [] : [f.previousPath])]));
    const seen = (f: ChangedFile) => since !== null && (changed === null || !changed.has(f.path));
    return ok(c, {
      nodeId,
      repo: review.repo,
      prNumber: review.prNumber,
      branch: review.branch,
      baseSha: review.baseSha,
      headSha: review.headSha,
      lastSeenSha: since,
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
    const file = fileAt(await c.var.forge.compare(review.repo, query.since ?? review.baseSha, review.headSha), query.path);
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
