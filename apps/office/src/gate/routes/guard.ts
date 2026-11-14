// 自動停止: 停止中の対象、止めた記録の一覧と 1 件、手で止める、判定、再開、止める前の確認 (ルートの一覧の 1.5、自動停止の 3.6、3.7)
import type { D1Database } from "@cloudflare/workers-types";
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, CreateStopInput, newId, GuardScope, GuardState, Resumption, Stop, StopDetail, StopPreview, StopRow, StopTargetInput, StopUpdate, StopVerdict, VerdictInput } from "@know-office/core";
import { and, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { stops, stopUpdates } from "../db/main.ts";
import { applyStop, guardDo, openStop, openStops, previewStop, resumeStop, type StopRowData, stopStates } from "../guard/actions.ts";
import { loadThresholds } from "../guard/thresholds.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, ok } from "../respond.ts";
import { clockAt } from "../work/attendance.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const StopParam = z.object({ stopId: z.uuid().openapi({ param: { name: "stopId", in: "path" }, description: "UUID v7" }) }).strict();

const getStateRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/state",
  operationId: "getGuardState",
  tags: ["guard"],
  responses: { 200: okResponse(GuardState), ...problems(401, 403, 429, 500) },
});

const listStopsRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/stops",
  operationId: "listStops",
  tags: ["guard"],
  request: {
    query: listQuery(router).extend({
      kind: z
        .enum(["stop", "near"])
        .optional()
        .openapi({ param: { name: "kind", in: "query" } }),
      scope: GuardScope.optional().openapi({ param: { name: "scope", in: "query" } }),
    }),
  },
  responses: { 200: listResponse(StopRow), ...problems(400, 401, 403, 422, 429, 500) },
});

const createStopRoute = createRoute({
  method: "post",
  path: "/api/v1/guard/stops",
  operationId: "createStop",
  tags: ["guard"],
  request: { body: jsonBody(CreateStopInput) },
  responses: { 201: okResponse(Stop, "作成した"), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500) },
});

const getStopRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/stops/{stopId}",
  operationId: "getStop",
  tags: ["guard"],
  request: { params: StopParam },
  responses: { 200: okResponse(StopDetail), ...problems(401, 403, 404, 429, 500) },
});

const judgeStopRoute = createRoute({
  method: "post",
  path: "/api/v1/guard/stops/{stopId}/verdict",
  operationId: "judgeStop",
  tags: ["guard"],
  request: { params: StopParam, body: jsonBody(VerdictInput) },
  responses: { 201: okResponse(StopUpdate, "作成した"), ...problems(400, 401, 403, 404, 413, 415, 422, 429, 500) },
});

const resumeStopRoute = createRoute({
  method: "post",
  path: "/api/v1/guard/stops/{stopId}/resume",
  operationId: "resumeStop",
  tags: ["guard"],
  "x-step-up": "conditional",
  request: { params: StopParam },
  responses: { 200: okResponse(Resumption), ...problems(401, 403, 404, 409, 429, 500) },
});

const previewStopRoute = createRoute({
  method: "post",
  path: "/api/v1/guard/stop-previews",
  operationId: "previewStop",
  tags: ["guard"],
  request: { body: jsonBody(StopTargetInput) },
  responses: { 200: okResponse(StopPreview), ...problems(400, 401, 403, 413, 415, 422, 429, 500) },
});

const iso = (at: number) => new Date(at).toISOString();
const Sources = z.array(z.string());
const RecentOps = z.object({ recentOps: z.array(z.looseObject({})) }).loose();

/**
 * stops の行を返す形に直す
 * @param row stops の行
 * @param state 再開した時刻と最後の判定
 * @param state.resumedAt 再開した時刻
 * @param state.verdict 最後の判定
 * @returns 一覧の 1 行
 */
function toRow(row: StopRowData, state: { resumedAt: number | null; verdict: string | null } | undefined): StopRow {
  const verdict = StopVerdict.safeParse(state?.verdict);
  return {
    id: row.id,
    at: iso(row.at),
    kind: row.kind,
    scope: GuardScope.parse(row.scope),
    target: row.target,
    signal: row.signal,
    measured: row.measured,
    threshold: row.threshold,
    by: row.by,
    resumedAt: state?.resumedAt === undefined || state.resumedAt === null ? null : iso(state.resumedAt),
    verdict: verdict.success ? verdict.data : null,
  };
}

/**
 * 止めた記録を読む
 * @param db 今の状態の D1
 * @param stopId 止めた記録の ID
 * @returns 止めた記録
 * @throws not_found 無い時
 */
async function findStop(db: D1Database, stopId: string): Promise<StopRowData> {
  const [row] = await drizzle(db).select().from(stops).where(eq(stops.id, stopId)).limit(1);
  if (!row) throw new AppError("not_found", "止めた記録が無い");
  return row;
}

/** 自動停止のルート */
export const guardRoutes = router
  .openapi(getStateRoute, async (c) => {
    const rows = await openStops(c.env.DB);
    return ok(c, { stopped: rows.map((r) => ({ scope: GuardScope.parse(r.scope), target: r.target, stopId: r.id, since: iso(r.at) })) });
  })
  .openapi(listStopsRoute, async (c) => {
    const { kind, scope, cursor, limit } = c.req.valid("query");
    const rows = await drizzle(c.env.DB)
      .select()
      .from(stops)
      .where(and(kind ? eq(stops.kind, kind) : undefined, scope ? eq(stops.scope, scope) : undefined, cursor ? lt(stops.id, cursor) : undefined))
      .orderBy(desc(stops.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const states = await stopStates(c.env.DB, page.map((r) => r.id));
    const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
    return list(c, page.map((r) => toRow(r, states.get(r.id))), next);
  })
  .openapi(createStopRoute, async (c) => {
    const { scope, target, reason } = c.req.valid("json");
    await previewStop(c.env.DB, scope, target);
    if (await openStop(c.env.DB, scope, target)) throw new AppError("conflict", "もう止めている");
    const { version } = await loadThresholds(c.env.DB);
    const stopId = await applyStop(
      c.env,
      { scope, target, signal: "manual", measured: 0, threshold: 0, rulesVersion: version, recentOps: [], externalSources: [], by: "owner", reason, traceId: c.var.traceId },
      c.var.clock.now(),
      c.var.guard,
    );
    if (!stopId) throw new AppError("conflict", "もう止めている");
    return created(c, { stopId }, `/api/v1/guard/stops/${stopId}`);
  })
  .openapi(getStopRoute, async (c) => {
    const row = await findStop(c.env.DB, c.req.valid("param").stopId);
    const updates = await drizzle(c.env.DB).select().from(stopUpdates).where(eq(stopUpdates.stopId, row.id)).orderBy(stopUpdates.id);
    const states = await stopStates(c.env.DB, [row.id]);
    const recorder = c.env.RECORDER.get(c.env.RECORDER.idFromName("recorder"));
    const found = await recorder.find(row.at, row.kind === "stop" ? "guard.stop" : "guard.near", row.id);
    // 監査ログの detail は記録 DO が JSON の文字列で書いた物なので、形を確かめてから使う
    const ops = RecentOps.safeParse(found?.detail ? JSON.parse(found.detail) : null);
    const sources = Sources.safeParse(row.externalSources);
    return ok(c, {
      ...toRow(row, states.get(row.id)),
      recentOps: ops.success ? ops.data.recentOps : [],
      updates: updates.map((u) => ({ id: u.id, at: iso(u.at), kind: u.kind, by: u.by, verdict: u.verdict, reason: u.reason })),
      rulesVersion: row.rulesVersion,
      model: row.model,
      externalSources: sources.success ? sources.data : [],
    });
  })
  .openapi(judgeStopRoute, async (c) => {
    const row = await findStop(c.env.DB, c.req.valid("param").stopId);
    const { verdict, reason } = c.req.valid("json");
    const now = c.var.clock.now();
    const id = newId(clockAt(now));
    await drizzle(c.env.DB).insert(stopUpdates).values({ id, stopId: row.id, at: now, kind: "verdict", by: "owner", verdict, reason });
    await audit(c, "guard.verdict", row.id, { verdict, reason });
    return created(c, { id, stopId: row.id, at: iso(now), kind: "verdict" as const, by: "owner" as const }, `/api/v1/guard/stops/${row.id}`);
  })
  .openapi(resumeStopRoute, async (c) => {
    const row = await findStop(c.env.DB, c.req.valid("param").stopId);
    if (row.kind === "near") throw new AppError("conflict", "近かった記録は再開できない");
    if (row.scope === "service" || row.scope === "office") requireStepUp(c);
    if (((await stopStates(c.env.DB, [row.id])).get(row.id)?.resumedAt ?? null) !== null) throw new AppError("conflict", "もう再開している");
    if (row.scope === "office" && (await guardDo(c.env).keysHeld())) throw new AppError("conflict", "GitHub App と Claude の鍵を入れ直してから再開する");
    const now = c.var.clock.now();
    if (!(await resumeStop(c.env, row, "owner", null, now, c.var.traceId))) throw new AppError("conflict", "もう再開している");
    return ok(c, { resumedAt: iso(now) });
  })
  .openapi(previewStopRoute, async (c) => {
    const { scope, target } = c.req.valid("json");
    return ok(c, await previewStop(c.env.DB, scope, target));
  });
