// 自動停止の基準と改善: しきい値、効き目、蒸留の案 (ルートの一覧の 1.5、自動停止の 3.6、3.7)
import { createRoute, z } from "@hono/zod-openapi";
import { DecisionInput, GuardEffect, GuardThresholds, Lesson, UpdateThresholdsInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { guardDo } from "../guard/actions.ts";
import { decideLesson, guardEffect, listLessons, updateThresholds } from "../guard/lessons.ts";
import { loadThresholds } from "../guard/thresholds.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const LessonParam = z.object({ lessonId: z.uuid().openapi({ param: { name: "lessonId", in: "path" }, description: "UUID v7" }) }).strict();
const Day = (name: string) => z.iso.date().optional().openapi({ param: { name, in: "query" }, description: "日本時間の日付 YYYY-MM-DD" });

const getThresholdsRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/thresholds",
  operationId: "getThresholds",
  tags: ["guard"],
  summary: "現在のしきい値",
  "x-steps": ["`settings` から `guard.thresholds` の最新の値を取得する"],
  responses: { 200: okResponse(GuardThresholds), ...problems(401, 403, 429, 500) },
});

const updateThresholdsRoute = createRoute({
  method: "put",
  path: "/api/v1/guard/thresholds",
  operationId: "updateThresholds",
  tags: ["guard"],
  summary: "しきい値を変更する",
  description: "15 分以内のパスキーの確認が必要。",
  "x-steps": [
    "`version` が現在と一致することを確認し、送った項目を今の値に重ねて基準の形に合うかを確かめる",
    "`lessonId` があれば、改善案が存在することを確認する",
    "`settings` への追加と、`lessonId` の改善案を `applied` にする更新を 1 回のバッチで行う。どちらも `version` より新しい行が無く、改善案が承認済みのしきい値の案である時だけ書く",
    "監査ログに `guard.thresholds` を、追加した `settings` の行を対象にし、変更前後の値と理由と新しい基準のハッシュとともに記録する",
    "`GuardDO.setThresholdHash()` に新しい基準のハッシュを渡す",
  ],
  "x-errors": [
    "404 `not_found`: `lessonId` の改善案が存在しない",
    "409 `conflict`: バージョンが異なる、または改善案が承認済みのしきい値の案でない",
    "422 `validation_failed`: 未知の項目か、基準の形に合わない値",
  ],
  "x-step-up": true,
  // 基準を変えると止める判断が変わるので、強める時も弱める時もパスキーで確かめる
  middleware: [stepUpGate] as const,
  request: { body: jsonBody(UpdateThresholdsInput) },
  responses: { 200: okResponse(GuardThresholds), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const getEffectRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/effect",
  operationId: "getGuardEffect",
  tags: ["guard"],
  summary: "自動停止の効果",
  "x-steps": [
    "期間の `stops` のうち停止した物を数え、`stop_updates` の最後の判定から誤って止めた割合を、シグナルごとの数から多い原因を出す",
    "`applied_at` のある改善策ごとに、同じ原因の停止を入れる前後 7 日間で比較する",
  ],
  "x-errors": ["422 `validation_failed`: `from` が `to` より後"],
  request: { query: z.object({ from: Day("from"), to: Day("to") }).strict() },
  responses: { 200: okResponse(GuardEffect), ...problems(400, 401, 403, 422, 429, 500) },
});

const listLessonsRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/lessons",
  operationId: "listLessons",
  tags: ["guard"],
  summary: "自動停止の改善案",
  "x-steps": ["`lessons` を新しい順に取得する。案は週に 1 度の蒸留のバッチ処理が `proposed` で入れる"],
  request: {
    // カーソルは案の ID なので、UUID の形だけを受ける
    query: listQuery(router).extend({ cursor: z.uuid().optional().openapi({ param: { name: "cursor", in: "query" }, description: "前のレスポンスの meta.next" }) }),
  },
  responses: { 200: listResponse(Lesson), ...problems(400, 401, 403, 422, 429, 500) },
});

const decideLessonRoute = createRoute({
  method: "post",
  path: "/api/v1/guard/lessons/{lessonId}/decision",
  operationId: "decideLesson",
  tags: ["guard"],
  summary: "改善案を承認または差し戻す",
  "x-steps": [
    "改善案を取得し、未決定であることを確認する",
    "承認の場合、指示文の案は `staffId` の社員の `staff_prompts` に案を足した新しいバージョンを追加して `staff.prompt_version` を進め、案を `applied` にする。ルールの案は開発担当に `fix` のタスクを追加して `approved` にする。しきい値の案は `approved` にするだけで、反映は `PUT /api/v1/guard/thresholds` で行う",
    "2 の書き込みと `lessons` の状態の更新を 1 回のバッチで行う。どれも改善案が未決定で、読んだ指示文のバージョンのままの時だけ書く",
    "監査ログに `lesson.decide` を記録する",
  ],
  "x-errors": ["404 `not_found`: 改善案が存在しない", "409 `conflict`: すでに決定済み、または決める間に指示文が変わった"],
  request: { params: LessonParam, body: jsonBody(DecisionInput) },
  responses: { 200: okResponse(Lesson), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** 自動停止の基準と改善のルート */
export const guardTuningRoutes = router
  .openapi(getThresholdsRoute, async (c) => {
    const { thresholds, version } = await loadThresholds(c.env.DB);
    return ok(c, { version, values: thresholds });
  })
  .openapi(updateThresholdsRoute, async (c) => {
    const input = c.req.valid("json");
    const changed = await updateThresholds(c.env, input, c.var.clock.now());
    // 5 分ごとの確かめが、settings の行とそれを入れた監査ログの行と GuardDO のハッシュを比べる。対象は足した行
    await audit(c, "guard.thresholds", changed.id, { before: changed.before, after: changed.after, version: changed.version, hash: changed.hash, reason: input.reason, lessonId: input.lessonId });
    await guardDo(c.env).setThresholdHash(changed.hash);
    return ok(c, { version: changed.version, values: changed.values });
  })
  .openapi(getEffectRoute, async (c) => ok(c, await guardEffect(c.env.DB, c.req.valid("query"))))
  .openapi(listLessonsRoute, async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const { items, next } = await listLessons(c.env.DB, cursor, limit);
    return list(c, items, next);
  })
  .openapi(decideLessonRoute, async (c) => {
    const { lessonId } = c.req.valid("param");
    const { decision, reason } = c.req.valid("json");
    const { lesson } = await decideLesson(c.env, lessonId, decision, { by: "owner", now: c.var.clock.now(), traceId: c.var.traceId });
    await audit(c, "lesson.decide", lessonId, { kind: lesson.kind, decision, status: lesson.status, reason });
    return ok(c, lesson);
  });
