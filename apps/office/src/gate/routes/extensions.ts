// 拡張の一覧と入れ切り (ルートの一覧の 1.14) と、入れた拡張のルートを /api/v1/ext/<ID> の下に付ける (サービスと拡張の 3.8)
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, Extension, ToggleExtensionInput } from "@know-office/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createRouter } from "../app.ts";
import type { GateEnv } from "../env.ts";
import type { ExtensionContext, ExtensionDefinition, ExtensionRoute } from "../extensions/define.ts";
import { enabledExtensions, extensionStates, extensionStore, toggleExtension } from "../extensions/state.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ExtensionParam = z.object({ extensionId: z.string().openapi({ param: { name: "extensionId", in: "path" } }) }).strict();

/**
 * その拡張を入れているかを確かめる。切っている間は 404 にし、本文も読まない
 * @param ext 拡張
 * @param extensions 読み込んだ拡張
 * @returns ミドルウェア
 */
function requireEnabled(ext: ExtensionDefinition, extensions: readonly ExtensionDefinition[]) {
  return createMiddleware<GateEnv>(async (c, next) => {
    const enabled = await enabledExtensions(c.env.DB, extensions);
    if (!enabled.some((e) => e.id === ext.id)) throw new AppError("not_found", "拡張機能が無効");
    await next();
  });
}

/**
 * 拡張の一覧の 1 件を作る
 * @param ext 拡張
 * @param enabled 入れているか
 * @returns 返す形
 */
const view =(ext: ExtensionDefinition, enabled: boolean): Extension => ({ id: ext.id, title: ext.title, enabled, ownerData: ext.ownerData });

/**
 * 拡張の中身に渡す物を作る。鍵、D1、DO は渡さず、時刻とその拡張の置き場だけを渡す
 * @param c 要求の文脈
 * @param ext 拡張
 * @returns 拡張の中身が受ける物
 */
function contextOf(c: Context<GateEnv>, ext: ExtensionDefinition): ExtensionContext {
  return { now: c.var.clock.now(), store: extensionStore(c.env.FILES, ext.id) };
}

/**
 * 拡張のルートを 1 つ付ける。入れているかの確かめは、本文を確かめるより前に置く
 * @param router ルートのまとまり
 * @param ext 拡張
 * @param r 拡張のルート
 * @param extensions 読み込んだ拡張
 */
function mount(router: OpenAPIHono<GateEnv>, ext: ExtensionDefinition, r: ExtensionRoute, extensions: readonly ExtensionDefinition[]): void {
  const base = { path: `/api/v1/ext/${ext.id}${r.path}`, operationId: r.operationId, summary: r.summary, tags: ["extensions"], middleware: requireEnabled(ext, extensions) };
  if (r.method === "get") {
    router.openapi(createRoute({ ...base, method: "get", responses: { 200: okResponse(r.response), ...problems(401, 403, 404, 429, 500) } }), async (c) => ok(c, await r.run(contextOf(c, ext))));
    return;
  }
  const route = createRoute({ ...base, method: "put", request: { body: jsonBody(r.body) }, responses: { 200: okResponse(r.response), ...problems(400, 401, 403, 404, 413, 415, 422, 429, 500) } });
  router.openapi(route, async (c) => {
    const body: unknown = c.req.valid("json");
    // 本文は createRoute の本文のスキーマで確かめた物なので、拡張の中身に渡せる
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const data = await r.run(contextOf(c, ext), body as never);
    await audit(c, "extension.write", ext.id, { operationId: r.operationId });
    return ok(c, data);
  });
}

/**
 * 拡張の一覧と入れ切りのルートに、読み込んだ拡張のルートを足す
 * @param extensions 読み込んだ拡張
 * @returns ルートのまとまり
 */
export function extensionRoutes(extensions: readonly ExtensionDefinition[]) {
  const router = createRouter();
  const listExtensionsRoute = createRoute({
    method: "get",
    path: "/api/v1/extensions",
    operationId: "listExtensions",
    tags: ["extensions"],
    request: { query: listQuery(router) },
    responses: { 200: listResponse(Extension), ...problems(400, 401, 403, 422, 429, 500) },
  });
  const toggleExtensionRoute = createRoute({
    method: "put",
    path: "/api/v1/extensions/{extensionId}",
    operationId: "toggleExtension",
    tags: ["extensions"],
    request: { params: ExtensionParam, body: jsonBody(ToggleExtensionInput) },
    responses: { 200: okResponse(Extension), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
  });

  const routes = router
    .openapi(listExtensionsRoute, async (c) => {
      const { cursor, limit } = c.req.valid("query");
      const states = await extensionStates(c.env.DB, extensions);
      // ID の順の並びを、ID をカーソルにして切る
      const rest = extensions.filter((e) => cursor === undefined || e.id > cursor);
      const page = rest.slice(0, limit);
      return list(
        c,
        page.map((e) => view(e, states.get(e.id)?.enabled === true)),
        rest.length > limit ? (page.at(-1)?.id ?? null) : null,
      );
    })
    .openapi(toggleExtensionRoute, async (c) => {
      const { extensionId } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      const ext = extensions.find((e) => e.id === extensionId);
      if (!ext) throw new AppError("not_found", "拡張機能が存在しない");
      const current = (await extensionStates(c.env.DB, [ext])).get(ext.id)?.version ?? 0;
      const version = await toggleExtension(c.env.DB, { id: ext.id, enabled, now: c.var.clock.now() }, current);
      await audit(c, "extension.toggle", ext.id, { enabled, version });
      return ok(c, view(ext, enabled));
    });

  for (const ext of extensions) for (const r of ext.routes) mount(routes, ext, r, extensions);
  return routes;
}
