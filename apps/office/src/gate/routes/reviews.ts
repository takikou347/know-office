// レビュー: オーナーの承認と差し戻し、行の指摘、その場の直しを受け、GitHub のプルリクエストに写す (ルートの一覧の 1.9、タスクとレビューの 3.6)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, Commit, CreateCommitInput, CreateNoteInput, newId, ReviewNote, ReviewVerdict, ReviewVerdictInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { enqueueMirror, sendMirror } from "../github/mirror.ts";
import { audit } from "../ledger/record.ts";
import { okResponse, problems } from "../openapi.ts";
import { created, ok } from "../respond.ts";
import { type Actor, appendNodeEvent, findNode } from "../work/nodes.ts";
import { backToTodo, callMaker, findReview, mergeIfReady, repoRefusal } from "../work/review.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const NodeParam = z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict();
const location = { Location: { description: "作成したリソースの URL", schema: { type: "string" as const } } };

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
  request: { params: NodeParam, body: jsonBody(CreateNoteInput) },
  responses: { 201: { ...okResponse(ReviewNote, "作成した"), headers: location }, ...problems(400, 401, 403, 404, 413, 415, 422, 429, 500) },
});

const createReviewCommitRoute = createRoute({
  method: "post",
  path: "/api/v1/reviews/{nodeId}/commits",
  operationId: "createReviewCommit",
  tags: ["reviews"],
  request: { params: NodeParam, body: jsonBody(CreateCommitInput) },
  responses: { 201: { ...okResponse(Commit, "作成した"), headers: location }, ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
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
    const statements = [db.prepare("UPDATE reviews SET owner_verdict = ? WHERE id = ? AND head_sha = ?").bind(input.verdict, review.id, input.baseSha), mirror.statement];
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
        merged = await mergeIfReady(c.env, c.var.forge, made, { repo: review.repo, branch: review.branch, prNumber: review.prNumber, reviewer: null }, { staffId: null, kind: "owner_approved", detail }, actor);
      } else {
        await appendNodeEvent(c.env, { nodeId, staffId: null, kind: "owner_approved", detail }, actor);
      }
    }
    // 写せなければ記録に残し、5 分ごとの定期ジョブが写し直す
    await sendMirror(c.env, c.var.forge, mirror.id, c.var.clock);
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
    // 同じ push の synchronize の通知が先に届いていれば、もう新しい先になっている
    await c.env.DB.prepare("UPDATE reviews SET head_sha = ?, checks = '[]' WHERE id = ? AND head_sha = ?").bind(sha, review.id, input.baseSha).run();
    await audit(c, "review.commit", nodeId, { repo: review.repo, sha, path: input.path });
    return created(c, { sha }, `/api/v1/reviews/${nodeId}/commits/${sha}`);
  });
