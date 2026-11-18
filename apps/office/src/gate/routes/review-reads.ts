// レビューを読む道。ワークスペースを起こさず、ゲートウェイが GitHub の compare とファイルの API から取り、前に見た所からの差と読んだ所の印を持つ。PR を出す前の作業中のブランチも同じ道で読む (API の reviews、タスクとレビューの 3.6)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, decideRepo, FileContent, FileDiff, languageOfPath, ReviewDiffQuery, ReviewFileQuery, ReviewHead, SeenInput } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { createRouter } from "../app.ts";
import { repoScope } from "../github/rules.ts";
import { okResponse, problems } from "../openapi.ts";
import { noContent, ok } from "../respond.ts";
import type { ChangedFile, Forge } from "../work/loop.ts";
import { findReview, findReviewOrWorking, type ReviewRow, type WorkingBranch } from "../work/review.ts";

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

/**
 * 作業中のブランチのリポジトリを、ルールが読ませるかを GitHub を呼ぶ前に確かめる
 * @param db 今の状態の D1
 * @param working 作業中のブランチ
 * @throws rule_denied ルールがリポジトリを読ませない時
 */
async function assertReadable(db: D1Database, working: WorkingBranch): Promise<void> {
  const decision = decideRepo({ action: "read", repo: working.repo, paths: [] }, await repoScope(db, working.repo));
  if (!decision.allow) throw new AppError("rule_denied", decision.reason);
}

/**
 * 作業中のブランチの元から先までの compare を読む。300 件ちょうどなら切れているかもしれないので断る
 * @param forge GitHub
 * @param repo リポジトリ
 * @param base 元
 * @param head 先
 * @returns 変わったファイルと共通の祖先
 * @throws upstream_failed GitHub から読めない時、300 件で切れている時
 */
async function workingCompare(forge: Forge, repo: string, base: string, head: string): Promise<{ files: ChangedFile[]; baseSha: string | null }> {
  const compared = await forge.compare(repo, base, head);
  if (compared.truncated) throw new AppError("upstream_failed", "作業中の変更が多すぎて読み切れない");
  return compared;
}

/**
 * 作業中のブランチの概要を作る。ブランチの先、既定のブランチの先、その間の compare を 1 回ずつ読み、元は 2 つの共通の祖先にする。まだ push が無ければ空の変更
 * @param forge GitHub
 * @param working 作業中のブランチ
 * @returns 概要
 * @throws upstream_failed GitHub から読めない時、300 件で切れている時、共通の祖先が返らない時
 */
async function workingHead(forge: Forge, working: WorkingBranch): Promise<ReviewHead> {
  const empty = { nodeId: working.nodeId, repo: working.repo, prNumber: null, branch: working.branch, lastSeenSha: null, working: true, checks: [], reviewerSummary: "", reviewerVerdict: null };
  const head = await forge.findBranchHead(working.repo, working.branch);
  if (head === null) return { ...empty, baseSha: null, headSha: null, files: [] };
  const compared = await workingCompare(forge, working.repo, await forge.defaultHead(working.repo), head);
  if (compared.baseSha === null) throw new AppError("upstream_failed", "GitHub が共通の祖先を返さない");
  return { ...empty, baseSha: compared.baseSha, headSha: head, files: compared.files.map((f) => ({ path: f.path, status: f.status, seen: false })) };
}

/**
 * 作業中の差分とファイルの問いから、元と先を取り出す
 * @param query 問い
 * @param query.baseSha 概要が返した元
 * @param query.headSha 概要が返した先
 * @param query.since 前に見た先。作業中には無い
 * @returns 元と先
 * @throws malformed_request 元か先が無い時、since を付けた時
 */
function workingRange(query: { baseSha?: string | undefined; headSha?: string | undefined; since?: string | undefined }): { base: string; head: string } {
  if (query.since !== undefined) throw new AppError("malformed_request", "作業中の変更には前に見た所が無い");
  if (query.baseSha === undefined || query.headSha === undefined) throw new AppError("malformed_request", "作業中の変更は概要が返した baseSha と headSha を付けて読む");
  return { base: query.baseSha, head: query.headSha };
}

/**
 * レビューの行のある差分とファイルの問いに、作業中だけの元と先が無い事を確かめる
 * @param query 問い
 * @param query.baseSha 元
 * @param query.headSha 先
 * @throws malformed_request 元か先を付けた時
 */
function assertNoRange(query: { baseSha?: string | undefined; headSha?: string | undefined }): void {
  if (query.baseSha !== undefined || query.headSha !== undefined) throw new AppError("malformed_request", "baseSha と headSha は作業中の変更だけで使う");
}

const getReviewRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}",
  operationId: "getReview",
  tags: ["reviews"],
  summary: "レビューの概要",
  description: "レビュー担当の要約、チェック結果、変更ファイルのツリー。プルリクエストを出す前の作業中のブランチは `working: true` で返す。",
  "x-steps": [
    "`reviews` を取得する。無ければ `nodes` を読み、リポジトリとブランチがあり `pr_number` が無いタスクなら作業中の変更として読む。どちらでもなければ 404",
    "作業中の変更は、リポジトリを読む操作がルールで許されなければ GitHub を呼ばずに 403。ブランチの先、既定のブランチの先、その間の compare を 1 回ずつ読み、元を 2 つの共通の祖先 (`merge_base_commit`) にする。ブランチがまだ無ければ (404) 空の変更を返す。compare が 300 件ちょうどなら 502",
    "レビューの行があれば、プルリクエストのファイルの一覧 API を 100 件ずつのページで読み、変更ファイルの一覧を取得する。30 ページ目まで満ちていれば 502。ワークスペースは起こさない",
    "`last_seen_sha` が今の `head_sha` と違えば、そこから `head_sha` までの compare に入るファイルを未読にする。compare が 300 件ちょうどで切れているかもしれない時は、全部を未読にする",
  ],
  "x-errors": ["403 `rule_denied`: 作業中の変更のリポジトリを読む操作がルールで許されない", "404 `not_found`: レビューも作業中のブランチも存在しない", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した"],
  request: { params: NodeParam },
  responses: { 200: okResponse(ReviewHead), ...problems(401, 403, 404, 429, 500, 502) },
});

const getReviewDiffRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/diff",
  operationId: "getReviewDiff",
  tags: ["reviews"],
  summary: "1 ファイルの差分",
  description: "since を指定すると、前回確認した時点からの差分を返す。作業中の変更は、概要が返した `baseSha` と `headSha` の間の差分を返す。",
  "x-steps": [
    "作業中の変更は、`since` があれば 400、`baseSha` か `headSha` が無ければ 400、ルールで読めなければ 403。`baseSha` から `headSha` までの compare API から 1 ファイル分の差分を取り出す。概要の後に push があっても同じ元と先を読む",
    "レビューの行があれば、`baseSha` か `headSha` を付けると 400。`since` が無ければプルリクエストのファイルの一覧 API から、あれば `since` から `head_sha` までの compare API から、1 ファイル分の差分を取り出す",
    "compare が 300 件ちょうどなら 502。ワークスペースは起こさない",
  ],
  "x-errors": ["400 `malformed_request`: 作業中の変更に `since` を付けた、`baseSha` と `headSha` が無い、またはレビューの行のある変更に付けた", "403 `rule_denied`: 作業中の変更のリポジトリを読む操作がルールで許されない", "404 `not_found`: ファイルが存在しない", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した"],
  request: { params: NodeParam, query: ReviewDiffQuery },
  responses: { 200: okResponse(FileDiff), ...problems(400, 401, 403, 404, 422, 429, 500, 502) },
});

const getReviewFileRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/file",
  operationId: "getReviewFile",
  tags: ["reviews"],
  summary: "変更前または変更後のファイル内容",
  "x-steps": [
    "作業中の変更は、`baseSha` か `headSha` が無ければ 400、ルールで読めなければ 403。`ref` が `base` なら `baseSha`、`head` なら `headSha` のファイルを読む。レビューの行があれば、`baseSha` か `headSha` を付けると 400 で、行の元か先を読む",
    "変更前または変更後のファイル内容を contents API から取得する",
  ],
  "x-errors": ["400 `malformed_request`: 作業中の変更に `baseSha` と `headSha` が無い、またはレビューの行のある変更に付けた", "403 `rule_denied`: 作業中の変更のリポジトリを読む操作がルールで許されない", "404 `not_found`: ファイルが存在しない", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した"],
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
  "x-errors": ["404 `not_found`: レビューが存在しない", "409 `conflict`: 確認した後に変更が追加された、またはプルリクエストを出す前の作業中の変更"],
  request: { params: NodeParam, body: { content: { "application/json": { schema: SeenInput } }, required: true } },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** レビューを読むルート */
export const reviewReadRoutes = router
  .openapi(getReviewRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const found = await findReviewOrWorking(c.env.DB, nodeId);
    if (found.kind === "working") {
      await assertReadable(c.env.DB, found);
      return ok(c, await workingHead(c.var.forge, found));
    }
    const review = found.row;
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
      working: false,
      checks: Checks.parse(review.checks),
      reviewerSummary: review.reviewerSummary ?? "",
      reviewerVerdict: review.reviewerVerdict,
      files: files.map((f) => ({ path: f.path, status: f.status, seen: seen(f) })),
    });
  })
  .openapi(getReviewDiffRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const query = c.req.valid("query");
    const found = await findReviewOrWorking(c.env.DB, nodeId);
    let files: ChangedFile[];
    if (found.kind === "working") {
      const range = workingRange(query);
      await assertReadable(c.env.DB, found);
      files = (await workingCompare(c.var.forge, found.repo, range.base, range.head)).files;
    } else {
      assertNoRange(query);
      files = await diffFiles(c.var.forge, found.row, query.since);
    }
    const file = fileAt(files, query.path);
    if (!file) throw new AppError("not_found", "このファイルは変わっていない");
    return ok(c, { path: file.path, language: languageOfPath(file.path), hunks: hunksOf(file.patch ?? "") });
  })
  .openapi(getReviewFileRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const query = c.req.valid("query");
    const found = await findReviewOrWorking(c.env.DB, nodeId);
    let target: { repo: string; base: string; head: string };
    if (found.kind === "working") {
      const range = workingRange(query);
      await assertReadable(c.env.DB, found);
      target = { repo: found.repo, ...range };
    } else {
      assertNoRange(query);
      target = { repo: found.row.repo, base: found.row.baseSha, head: found.row.headSha };
    }
    const ref = query.ref === "base" ? target.base : target.head;
    const content = await c.var.forge.readFile(target.repo, ref, query.path);
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
