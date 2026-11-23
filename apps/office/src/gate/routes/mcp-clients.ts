// MCP の連携の一覧、作る、切る。外の AI が MCP でつなぐ鍵を画面で管理する (ログインと記録の 3.10)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, CreatedMcpClient, CreateMcpClientInput, McpClient, newId, sha256Hex, toBase64url } from "@know-office/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { mcpClients } from "../db/main.ts";
import { audit } from "../ledger/record.ts";
import { createdResponse, listResponse, problems } from "../openapi.ts";
import { created, list, noContent } from "../respond.ts";

const router = createRouter();

/** 画面の一覧に出す数。連携はオーナーが手で作る数件なので 1 ページで返し、cursor は持たない */
const LIST_MAX = 100;

const ClientParam = z.object({ mcpClientId: z.uuid().openapi({ param: { name: "mcpClientId", in: "path" }, description: "UUID v7" }) }).strict();

const listMcpClientsRoute = createRoute({
  method: "get",
  path: "/api/v1/mcp-clients",
  operationId: "listMcpClients",
  tags: ["auth"],
  summary: "MCP の連携の一覧",
  "x-steps": ["`mcp_clients` を新しい順に 100 件まで返す。鍵は返さない"],
  responses: { 200: listResponse(McpClient), ...problems(401, 403, 429, 500) },
});

const createMcpClientRoute = createRoute({
  method: "post",
  path: "/api/v1/mcp-clients",
  operationId: "createMcpClient",
  tags: ["auth"],
  summary: "MCP の連携を作り、鍵を 1 度だけ返す",
  description: "外の AI が know-office を読み、承認と指示を出せるようになるので、パスキーの確認が要る。",
  "x-steps": ["パスキーの確認を求める", "32 バイトの乱数の鍵を作り、`mcp_clients` に SHA-256 だけを置く", "監査ログに `mcp_client.create` を記録し、鍵をこの 1 度だけ返す"],
  "x-step-up": true,
  // 外からできる事を増やすので、入力を確かめる前にパスキーで確かめる
  middleware: [stepUpGate] as const,
  request: { body: { required: true, content: { "application/json": { schema: CreateMcpClientInput } } } },
  responses: { 201: createdResponse(CreatedMcpClient), ...problems(400, 401, 403, 413, 415, 422, 429, 500) },
});

const revokeMcpClientRoute = createRoute({
  method: "delete",
  path: "/api/v1/mcp-clients/{mcpClientId}",
  operationId: "revokeMcpClient",
  tags: ["auth"],
  summary: "MCP の連携を切る",
  "x-steps": ["切っていない連携の時だけ `revoked_at` を書く。切った鍵は次の要求から通らない", "監査ログに `mcp_client.revoke` を記録する"],
  "x-errors": ["404 `not_found`: 連携が無いか、もう切ってある"],
  request: { params: ClientParam },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(401, 403, 404, 429, 500) },
});

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

/**
 * mcp_clients の行を返す形にする。鍵のハッシュは出さない
 * @param row mcp_clients の行
 * @returns MCP の連携 1 件
 */
function toClient(row: typeof mcpClients.$inferSelect): McpClient {
  return { id: row.id, name: row.name, scope: row.scope, createdAt: new Date(row.createdAt).toISOString(), lastUsedAt: iso(row.lastUsedAt), revokedAt: iso(row.revokedAt) };
}

/** MCP の連携のルート */
export const mcpClientRoutes = router
  .openapi(listMcpClientsRoute, async (c) => {
    const rows = await drizzle(c.env.DB).select().from(mcpClients).orderBy(desc(mcpClients.id)).limit(LIST_MAX);
    return list(c, rows.map(toClient), null);
  })
  .openapi(createMcpClientRoute, async (c) => {
    const { name, scope } = c.req.valid("json");
    const now = c.var.clock.now();
    // 鍵の頭で know-office の鍵と分かるようにし、漏れた時に探しやすくする
    const token = `ko_mcp_${toBase64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const row = { id: newId(c.var.clock), name, scope, tokenHash: await sha256Hex(token), createdAt: now, lastUsedAt: null, revokedAt: null };
    await drizzle(c.env.DB).insert(mcpClients).values(row);
    await audit(c, "mcp_client.create", row.id, { name, scope });
    return created(c, { client: toClient(row), token }, `/api/v1/mcp-clients/${row.id}`);
  })
  .openapi(revokeMcpClientRoute, async (c) => {
    const { mcpClientId } = c.req.valid("param");
    // 切っていない時だけ書き、書けた件数で 404 を決める
    const revoked = await drizzle(c.env.DB)
      .update(mcpClients)
      .set({ revokedAt: c.var.clock.now() })
      .where(and(eq(mcpClients.id, mcpClientId), isNull(mcpClients.revokedAt)))
      .returning({ id: mcpClients.id });
    if (revoked.length === 0) throw new AppError("not_found", "MCP の連携が無いか、もう切ってある");
    await audit(c, "mcp_client.revoke", mcpClientId);
    return noContent(c);
  });
