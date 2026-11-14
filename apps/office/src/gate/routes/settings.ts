// 設定: office の設定とサービスの初期値、サービスごとの設定 (ルートの一覧の 1.12、サービスと拡張の 3.3)
import type { D1Database } from "@cloudflare/workers-types";
import { createRoute, z } from "@hono/zod-openapi";
import { DEFAULT_SCHEDULE, INHERITED_KEYS, Setting, UpdateSettingInput } from "@know-office/core";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { settings } from "../db/main.ts";
import { loadThresholds } from "../guard/thresholds.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";
import { DEFAULT_PREFIX, loadOfficeDefaults, loadServiceSettings, updateOfficeDefault, updateServiceSetting } from "../services/settings.ts";
import { loadSchedule } from "../work/attendance.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ServiceParam = z.object({ serviceId: z.uuid().openapi({ param: { name: "serviceId", in: "path" }, description: "UUID v7" }) }).strict();
const KeyParam = z.object({ key: z.string().openapi({ param: { name: "key", in: "path" } }) }).strict();

const listServiceSettingsRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{serviceId}/settings",
  operationId: "listServiceSettings",
  tags: ["settings"],
  request: { params: ServiceParam, query: listQuery(router) },
  responses: { 200: listResponse(Setting), ...problems(400, 401, 403, 404, 422, 429, 500) },
});

const updateServiceSettingRoute = createRoute({
  method: "put",
  path: "/api/v1/services/{serviceId}/settings/{key}",
  operationId: "updateServiceSetting",
  tags: ["settings"],
  request: { params: ServiceParam.extend(KeyParam.shape), body: jsonBody(UpdateSettingInput) },
  responses: { 200: okResponse(Setting), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

const listSettingsRoute = createRoute({
  method: "get",
  path: "/api/v1/settings",
  operationId: "listSettings",
  tags: ["settings"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(Setting), ...problems(400, 401, 403, 422, 429, 500) },
});

const updateSettingRoute = createRoute({
  method: "put",
  path: "/api/v1/settings/{key}",
  operationId: "updateSetting",
  tags: ["settings"],
  request: { params: KeyParam, body: jsonBody(UpdateSettingInput) },
  responses: { 200: okResponse(Setting), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/**
 * 項目の決まった並びを、キーをカーソルにして 1 ページに切る
 * @param items 決まった順の項目
 * @param page カーソルと件数
 * @param page.cursor 前のページの最後のキー
 * @param page.limit 件数
 * @returns 1 ページと次のカーソル
 */
function pageOf(items: Setting[], page: { cursor?: string | undefined; limit: number }): { items: Setting[]; next: string | null } {
  const start = page.cursor === undefined ? 0 : items.findIndex((s) => s.key === page.cursor) + 1;
  // 知らないカーソルは並びの外なので、続きを返さない
  const from = page.cursor !== undefined && start === 0 ? items.length : start;
  const slice = items.slice(from, from + page.limit);
  return { items: slice, next: from + page.limit < items.length ? (slice.at(-1)?.key ?? null) : null };
}

/**
 * 勤務の時刻の最新の版を読む
 * @param db 今の状態の D1
 * @returns 版。行が無ければ 0
 */
async function scheduleVersion(db: D1Database): Promise<number> {
  const [row] = await drizzle(db)
    .select({ version: settings.version })
    .from(settings)
    .where(and(eq(settings.key, "workday.schedule"), eq(settings.scope, "office")))
    .orderBy(desc(settings.version))
    .limit(1);
  return row?.version ?? 0;
}

/** 設定のルート */
export const settingRoutes = router
  .openapi(listServiceSettingsRoute, async (c) => {
    const all = await loadServiceSettings(c.env.DB, c.req.valid("param").serviceId);
    const { items, next } = pageOf(all, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(updateServiceSettingRoute, async (c) => {
    const { serviceId, key } = c.req.valid("param");
    const { version, value, reason } = c.req.valid("json");
    const setting = await updateServiceSetting(c.env.DB, { serviceId, key, value, version, now: c.var.clock.now() });
    await audit(c, "service.setting", serviceId, { key, value, version: setting.version, reason });
    return ok(c, setting);
  })
  .openapi(listSettingsRoute, async (c) => {
    const db = c.env.DB;
    const [schedule, version, thresholds, defaults] = await Promise.all([loadSchedule(db), scheduleVersion(db), loadThresholds(db), loadOfficeDefaults(db)]);
    const all: Setting[] = [
      { key: "workday.schedule", value: version === 0 ? DEFAULT_SCHEDULE : schedule, inherited: version === 0, version },
      { key: "guard.thresholds", value: thresholds.thresholds, inherited: thresholds.version === 0, version: thresholds.version },
      ...INHERITED_KEYS.map((k) => ({ key: `${DEFAULT_PREFIX}${k}`, value: defaults[k].value, inherited: !defaults[k].set, version: defaults[k].version })),
    ];
    const { items, next } = pageOf(all, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(updateSettingRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { version, value, reason } = c.req.valid("json");
    const setting = await updateOfficeDefault(c.env.DB, { key, value, version, reason, now: c.var.clock.now() });
    await audit(c, "setting.update", key, { value: setting.value, version: setting.version, reason });
    return ok(c, setting);
  });
