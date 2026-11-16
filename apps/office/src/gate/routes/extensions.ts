// 拡張の一覧と入れ切り (ルートの一覧の 1.14) と、入れた拡張のルートを /api/v1/ext/<ID> の下に付ける (サービスと拡張の 3.8)
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, EXTENSION_ID, Extension, ToggleExtensionInput } from "@know-office/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createRouter } from "../app.ts";
import { requireStepUp, stepUpGate } from "../auth/passkey.ts";
import type { GateEnv } from "../env.ts";
import type { ExtensionContext, ExtensionDefinition, ExtensionRoute } from "../extensions/define.ts";
import { enabledExtensions, extensionStates, extensionStore, toggleExtension } from "../extensions/state.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { openOwnerFields, putOwnerData } from "../work/owner-data.ts";
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
const view = (ext: ExtensionDefinition, enabled: boolean): Extension => ({ id: ext.id, title: ext.title, enabled, ownerData: ext.ownerData });

/**
 * 拡張の中身に渡す物を作る。鍵、D1、DO は渡さず、時刻とその拡張の置き場を渡す。
 * オーナーの情報を扱う拡張には、項目ごとに暗号にして置き、読むたびにオーナーが読んだ記録を残す置き場も渡す
 * @param c 要求の文脈
 * @param ext 拡張
 * @returns 拡張の中身が受ける物
 */
function contextOf(c: Context<GateEnv>, ext: ExtensionDefinition): ExtensionContext {
  const now = c.var.clock.now();
  const ownerData = ext.ownerData
    ? {
        get: (fields: readonly string[]) => openOwnerFields(c.env.DB, c.env.MASTER_KEY, { extId: ext.id, fields, by: "owner", nodeId: null }, now),
        put: (values: Readonly<Record<string, string>>) => putOwnerData(c.env.DB, c.env.MASTER_KEY, ext.id, values, now),
      }
    : null;
  return { now, store: extensionStore(c.env.FILES, ext.id), ownerData };
}

/**
 * 拡張のルートを 1 つ付ける。入れているかの確かめは、本文を確かめるより前に置く
 * @param router ルートのまとまり
 * @param ext 拡張
 * @param r 拡張のルート
 * @param extensions 読み込んだ拡張
 */
function mount(router: OpenAPIHono<GateEnv>, ext: ExtensionDefinition, r: ExtensionRoute, extensions: readonly ExtensionDefinition[]): void {
  // オーナーの情報を扱う拡張は、読むルートも開くたびにパスキーで確かめる。確認は入れているかと入力の確かめより先に断る
  const middleware = ext.ownerData ? [stepUpGate, requireEnabled(ext, extensions)] : [requireEnabled(ext, extensions)];
  const base = {
    path: `/api/v1/ext/${ext.id}${r.path}`,
    operationId: r.operationId,
    summary: r.summary,
    tags: ["extensions"],
    "x-steps": [`${ext.ownerData ? "パスキーの確認を確かめ、" : ""}拡張機能 \`${ext.id}\` が有効であることを確認する`, ...r.steps],
    "x-errors": [...(ext.ownerData ? ["401 `step_up_required`: パスキーの確認が無いか、15 分を過ぎた"] : []), "404 `not_found`: 拡張機能が無効"],
    middleware,
    ...(ext.ownerData ? { "x-step-up": true } : {}),
  };
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
    summary: "拡張機能の一覧",
    "x-steps": ["読み込んだ拡張機能を ID の順に並べ、`settings` の `extension.<拡張機能 ID>` の最新の値で有効化の状態を返す。行が無い拡張機能は無効とする"],
    request: { query: listQuery(router) },
    responses: { 200: listResponse(Extension), ...problems(400, 401, 403, 422, 429, 500) },
  });
  const toggleExtensionRoute = createRoute({
    method: "put",
    path: "/api/v1/extensions/{extensionId}",
    operationId: "toggleExtension",
    tags: ["extensions"],
    summary: "拡張機能を有効化、無効化する",
    description: "有効にする場合のみパスキーの確認が必要。",
    "x-steps": [
      "有効にする時は、パスキーの確認があることを確認する。無ければ監査ログに `extension.toggle_refused` を記録して断る",
      "拡張機能が存在することを確認する",
      "`settings` に `extension.<拡張機能 ID>` の行を、最新のバージョンに 1 を足して追加し、監査ログに `extension.toggle` を記録する。無効にしても拡張機能のデータは消さない",
    ],
    "x-errors": [
      "401 `step_up_required`: 有効にする時に、パスキーの確認がない",
      "404 `not_found`: 拡張機能が存在しない",
      "409 `conflict`: 同時に入れ切りされ、バージョンが異なる",
    ],
    "x-step-up": "conditional",
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
      // 入れると社員のツールとルートが増えるので、守りを弱める変更としてパスキーの確認を求める。断った試みも残す
      if (enabled) {
        try {
          requireStepUp(c);
        } catch (error) {
          // ID の形を確かめる前なので、拡張 ID の形の時だけ記録に写す
          const target = extensionId.length <= 64 && EXTENSION_ID.test(extensionId) ? extensionId : null;
          await audit(c, "extension.toggle_refused", target, { enabled, reason: "step_up_required" });
          throw error;
        }
      }
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
