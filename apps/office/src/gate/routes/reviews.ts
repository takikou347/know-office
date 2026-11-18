// レビュー: オーナーの承認と差し戻し、行の指摘、その場の直しを受け、GitHub のプルリクエストに写す (API の reviews、タスクとレビューの 3.6)
import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { AppError, Commit, CreateCommitInput, CreateNoteInput, newId, ReviewNote, ReviewVerdict, ReviewVerdictInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { enqueueMirror, sendMirror } from "../github/mirror.ts";
import { audit } from "../ledger/record.ts";
import { createdResponse, okResponse, problems } from "../openapi.ts";
import { created, ok } from "../respond.ts";
import { type Actor, appendNodeEvent, findNode } from "../work/nodes.ts";
import { askReview, backToTodo, callMaker, findReview, mergeIfReady, repoRefusal, reviewAsked } from "../work/review.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const NodeParam = z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict();

/** オーナーが写した物の本文の頭。GitHub の上では App の名前で出るので、誰の判断かを本文に書く */
const OWNER_PREFIX = "オーナー: ";

/**
 * オーナーの承認か差し戻し。書く順は次のとおり
 * 1. 判断、GitHub に写す順番待ち、差し戻しなら作った社員のタスクを todo に戻す事を、確かめた先のままの時だけ 1 回のバッチで書く
 * 2. タスクの出来事を足す。年ごとの記録の D1 にあるので、1 と同じバッチに入れられない
 * 3. 承認なら main に入れる条件を見て、そろえば先にタスクを done にしてから GitHub で main を進める。GitHub を呼ぶのでバッチの外で行い、進められなければ review に戻す
 * 4. GitHub のレビューに写す。写せなければ記録に残し、5 分ごとの定期ジョブが写し直す
 * 5. 監査ログに残す
 */
const submitReviewVerdictRoute = createRoute({
  method: "post",
  path: "/api/v1/reviews/{nodeId}/verdict",
  operationId: "submitReviewVerdict",
  tags: ["reviews"],
  summary: "承認または差し戻し",
  description: "GitHub に写せない時も判断は残し、写し直しを待つ。",
  "x-steps": [
    "`baseSha` が現在の `head_sha` と一致する時だけ、`owner_verdict` の更新と、GitHub に写す順番待ち (`github_mirrors`) へのレビューとコミットのステータスの追加を 1 回のバッチで書く",
    "App の pull_requests の書きに絞った鍵で、GitHub のプルリクエストのレビュー (承認は APPROVE、差し戻しは REQUEST_CHANGES、本文の頭に「オーナー」) として写す。App が出したプルリクエストで GitHub が 422 を返した時は、判断を本文の頭に書いた COMMENT のレビューにする。写せなければエラーログに残し、5 分ごとの定期ジョブが写し直す",
    "App の statuses の書きに絞った鍵で、`baseSha` のコミットに `know-office/owner-approval` のステータス (承認は success、差し戻しは failure) を出す。GitHub は App が自分で出した PR に可を付けさせないので、オーナーの判断はこのステータスで GitHub に出る",
    "承認の場合はマージの条件を確認して main を進め、差し戻しの場合はタスクを `todo` に戻す",
    "監査ログに `review.verdict` を記録する",
  ],
  "x-errors": [
    "404 `not_found`: レビューが存在しない",
    "409 `conflict`: 確認した後に変更が追加された",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: main を進める時に GitHub がエラーを返した",
  ],
  request: { params: NodeParam, body: jsonBody(ReviewVerdictInput) },
  responses: { 200: okResponse(ReviewVerdict), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
});

/**
 * オーナーの行の指摘。指摘、写す順番待ち、作った社員のタスクを todo に戻す事を 1 回のバッチで書き、出来事を足し、担当の社員を呼んでから GitHub の行のコメントに写す
 */
const createReviewNoteRoute = createRoute({
  method: "post",
  path: "/api/v1/reviews/{nodeId}/notes",
  operationId: "createReviewNote",
  tags: ["reviews"],
  summary: "行へのコメント",
  description: "GitHub に写せない時も指摘は残し、写し直しを待つ。",
  "x-steps": [
    "`review_notes` への追加と、GitHub に写す順番待ち (`github_mirrors`) への追加を 1 回のバッチで書く",
    "App の pull_requests の書きに絞った鍵で、GitHub のプルリクエストの行のコメント (本文の頭に「オーナー」、前の行は LEFT、後の行は RIGHT) として写す。写せなければエラーログに残し、5 分ごとの定期ジョブが写し直す",
    "作成した社員のタスクに `node_events` で追加し、タスクを `todo` に戻す",
  ],
  "x-errors": ["404 `not_found`: レビューが存在しない"],
  request: { params: NodeParam, body: jsonBody(CreateNoteInput) },
  responses: { 201: createdResponse(ReviewNote), ...problems(400, 401, 403, 404, 413, 415, 422, 429, 500) },
});

const createReviewCommitRoute = createRoute({
  method: "post",
  path: "/api/v1/reviews/{nodeId}/commits",
  operationId: "createReviewCommit",
  tags: ["reviews"],
  summary: "レビュー画面から修正をコミットする",
  "x-steps": [
    "`baseSha` が現在の `head_sha` と一致することを確認する",
    "変更禁止のパスを変えていないかをルールで確認する",
    "App の contents の書きに絞った鍵で、Git Data API でブランチにコミットを追加し、force なしでブランチの先を進める",
    "`baseSha` のままの時だけ、`head_sha` を新しいコミットにしてチェックの結果と承認を空にする事と、レビュー担当のレビューのタスクを立て直す事を 1 回のバッチで書く。開いたレビューのタスクがある時と、新しいコミットに承認がもう出ている時は立てない",
    "監査ログに `review.commit` を記録する",
  ],
  "x-errors": [
    "403 `rule_denied`: 変更禁止のパスを含む",
    "404 `not_found`: レビューが存在しない",
    "409 `conflict`: 確認した後に変更が追加された、または GitHub の側でブランチの先が進んだ",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した",
  ],
  request: { params: NodeParam, body: jsonBody(CreateCommitInput) },
  responses: { 201: createdResponse(Commit), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
});

/** レビューのルート */
export const reviewRoutes = router
  .openapi(submitReviewVerdictRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const input = c.req.valid("json");
    const review = await findReview(c.env.DB, nodeId);
    const db = c.env.DB;
    const now = c.var.clock.now();
    const event = input.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    // 確かめた先のままの時だけ、判断、写す順番待ち、差し戻しならタスクを todo に戻す事を 1 回のバッチで書く。間に push が届いていればどれも書かない
    const when = { sql: "EXISTS (SELECT 1 FROM reviews WHERE id = ? AND head_sha = ?)", args: [review.id, input.baseSha] };
    const mirror = enqueueMirror(c.env, review.id, { kind: "review", payload: { event, body: `${OWNER_PREFIX}${input.body}`, commitId: input.baseSha } }, c.var.clock, when);
    // App が出した PR には GitHub が可と不可を付けさせないので、判断はコミットのステータスでも出す
    const status = enqueueMirror(c.env, review.id, { kind: "status", payload: { state: input.verdict === "approve" ? "success" : "failure", commitId: input.baseSha } }, c.var.clock, when);
    const statements = [db.prepare("UPDATE reviews SET owner_verdict = ? WHERE id = ? AND head_sha = ?").bind(input.verdict, review.id, input.baseSha), mirror.statement, status.statement];
    if (input.verdict === "request_changes") statements.push(backToTodo(db, nodeId, now, when));
    const [updated] = await db.batch(statements);
    if ((updated?.meta.changes ?? 0) === 0) throw new AppError("conflict", "確かめた後に変更が足された");
    // 出来事の node_events は年ごとの記録の D1 (REC_<年>) にあり、D1 のバッチは 1 つの D1 の中だけなので、今の状態の DB と同じバッチに入れられない。書けた後に足す
    const actor: Actor = { by: "owner", now, traceId: c.var.traceId };
    const detail = { by: "owner", summary: input.body };
    let merged = false;
    if (input.verdict === "request_changes") {
      await appendNodeEvent(c.env, { nodeId, staffId: null, kind: "review_rejected", detail }, actor);
      await callMaker(c.env, nodeId, now);
    } else {
      const made = await findNode(db, nodeId);
      if (made.status === "review") {
        merged = await mergeIfReady(c.env, c.var.forge, made, { repo: review.repo, branch: review.branch, prNumber: review.prNumber, reviewer: null }, { staffId: null, kind: "owner_approved", detail }, actor, c.var.guard);
      } else {
        await appendNodeEvent(c.env, { nodeId, staffId: null, kind: "owner_approved", detail }, actor);
      }
    }
    // 写せなければ記録に残し、5 分ごとの定期ジョブが写し直す
    await sendMirror(c.env, c.var.forge, mirror.id, c.var.clock);
    await sendMirror(c.env, c.var.forge, status.id, c.var.clock);
    await audit(c, "review.verdict", nodeId, { verdict: input.verdict, merged });
    return ok(c, { nodeId, ownerVerdict: input.verdict });
  })
  .openapi(createReviewNoteRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const input = c.req.valid("json");
    const review = await findReview(c.env.DB, nodeId);
    const db = c.env.DB;
    const at = c.var.clock.now();
    const id = newId(c.var.clock);
    const side = input.side === "new" ? "RIGHT" : "LEFT";
    const mirror = enqueueMirror(c.env, review.id, { kind: "comment", payload: { noteId: id, path: input.path, line: input.line, side, body: `${OWNER_PREFIX}${input.body}`, commitId: review.headSha } }, c.var.clock);
    // 指摘、写す順番待ち、タスクを todo に戻す事を 1 回のバッチで書く
    await db.batch([
      db.prepare("INSERT INTO review_notes (id, review_id, at, by, path, line, side, body) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?)").bind(id, review.id, at, input.path, input.line, input.side, input.body),
      mirror.statement,
      backToTodo(db, nodeId, at),
    ]);
    // 出来事は年ごとの記録の D1 にあり、今の状態の DB と同じバッチに入れられないので、書けた後に足す
    const actor: Actor = { by: "owner", now: at, traceId: c.var.traceId };
    await appendNodeEvent(c.env, { nodeId, staffId: null, kind: "review_note", detail: { by: "owner", noteId: id, path: input.path, line: input.line, side: input.side, body: input.body } }, actor);
    await callMaker(c.env, nodeId, at);
    await sendMirror(c.env, c.var.forge, mirror.id, c.var.clock);
    return created(c, { id, at: new Date(at).toISOString(), by: "owner", ...input }, `/api/v1/reviews/${nodeId}/notes/${id}`);
  })
  .openapi(createReviewCommitRoute, async (c) => {
    const { nodeId } = c.req.valid("param");
    const input = c.req.valid("json");
    const review = await findReview(c.env.DB, nodeId);
    if (review.headSha !== input.baseSha) throw new AppError("conflict", "確かめた後に変更が足された");
    const refusal = await repoRefusal(c.env, c.var.forge, { action: "push", repo: review.repo, branch: review.branch, paths: [input.path] });
    if (refusal !== null) throw new AppError("rule_denied", refusal.reason);
    // GitHub の側でブランチの先が進んでいれば、force を付けないので conflict で断られる
    const sha = await c.var.forge.commitFile(review.repo, review.branch, { parent: input.baseSha, path: input.path, content: input.content, message: input.message });
    // 同じ push の synchronize の通知が先に届いていれば、もう新しい先になっている。先が進むので、前の先に出た承認は同じ文で消して待ち直し、同じバッチでレビュー担当に確かめ直しを求める
    // 求めるのは新しい先の承認が消えたままの時だけ (synchronize と同じ守り)。通知が先に届き、レビュー担当がその先を承認して閉じた後なら立てない
    const db = c.env.DB;
    const actor: Actor = { by: "system", now: c.var.clock.now(), traceId: c.var.traceId };
    const asked = await askReview(
      c.env,
      await findNode(db, nodeId),
      { repo: review.repo, branch: review.branch, prNumber: review.prNumber },
      actor,
      sql`EXISTS (SELECT 1 FROM reviews WHERE id = ${review.id} AND head_sha = ${sha} AND reviewer_verdict IS NULL AND owner_verdict IS NULL)`,
    );
    const results = await db.batch([
      db.prepare("UPDATE reviews SET head_sha = ?, checks = '[]', owner_verdict = NULL, reviewer_verdict = NULL WHERE id = ? AND head_sha = ?").bind(sha, review.id, input.baseSha),
      ...(asked ? [asked.statement] : []),
    ]);
    await reviewAsked(c.env, asked, results[1], actor);
    await audit(c, "review.commit", nodeId, { repo: review.repo, sha, path: input.path });
    return created(c, { sha }, `/api/v1/reviews/${nodeId}/commits/${sha}`);
  });
