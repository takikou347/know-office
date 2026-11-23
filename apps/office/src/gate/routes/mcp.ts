// MCP の入口。外の AI が know-office を読み、承認と社員への発言を、画面と同じルートと守りを通して出す (ログインと記録の 3.10)
import { createRoute } from "@hono/zod-openapi";
import { AppError, log, McpDecideArgs, McpMessageArgs, McpNoArgs, McpRequest, McpResponse, type McpScope, McpTaskArgs, sha256Hex } from "@know-office/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { createRouter } from "../app.ts";
import { recordLoginFailure } from "../auth/middleware.ts";
import { MCP_PATH } from "../auth/without-session.ts";
import { mcpClients } from "../db/main.ts";
import type { GateEnv } from "../env.ts";
import { audit } from "../ledger/record.ts";
import { problems } from "../openapi.ts";
import { notFound, onError } from "../problem.ts";
import { dashboardRoutes } from "./dashboard.ts";
import { messageRoutes } from "./messages.ts";
import { nodeRoutes } from "./nodes.ts";
import { orgRoutes } from "./org.ts";
import { staffRoutes } from "./staff.ts";

const router = createRouter();

/** 受ける MCP の版。新しい物から並べ、知らない版には先頭を返す */
// MCP の Lifecycle の Version Negotiation
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
/** 鍵の形。ko_mcp_ と 32 バイトの base64url */
const TOKEN = /^ko_mcp_[A-Za-z0-9_-]{43}$/;
/** last_used_at を書き直す間 (5 分)。要求ごとに D1 へ書かない */
const TOUCH_MS = 5 * 60_000;

/** 確かめた引数から作る、中で呼ぶルート */
type InnerCall = { method: "GET" | "POST"; path: string; body?: unknown };

/** MCP の道具 1 つ。画面と同じルートを 1 本だけ呼ぶ */
type Tool = {
  /** 道具の名前 */
  name: string;
  /** 外の AI に見せる説明 */
  description: string;
  /** 使うのに要る鍵の範囲 */
  scope: McpScope;
  /** 引数の形。tools/list に JSON Schema で出す */
  input: z.ZodType;
  /** 外から来た引数を確かめ、呼ぶルートを作る。道は確かめた ID だけから組み立てる */
  plan: (raw: unknown) => { ok: true; call: InnerCall } | { ok: false; detail: string };
};

/**
 * 引数の形と、確かめた引数からルートを作る関数から道具を作る。確かめは 1 度だけにする
 * @param spec 道具の名前、説明、範囲、引数の形、ルートの作り方
 * @param spec.name 道具の名前
 * @param spec.description 外の AI に見せる説明
 * @param spec.scope 使うのに要る鍵の範囲
 * @param spec.input 引数の形
 * @param spec.route 確かめた引数から呼ぶルートを作る
 * @returns 道具
 */
function defineTool<T>(spec: { name: string; description: string; scope: McpScope; input: z.ZodType<T>; route: (args: T) => InnerCall }): Tool {
  return {
    name: spec.name,
    description: spec.description,
    scope: spec.scope,
    input: spec.input,
    plan: (raw) => {
      const args = spec.input.safeParse(raw);
      if (!args.success) return { ok: false, detail: args.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("、") };
      return { ok: true, call: spec.route(args.data) };
    },
  };
}

/** 外の AI が使える道具。読む物は read、状態を変える物は write の鍵だけが使える */
export const MCP_TOOLS: readonly Tool[] = [
  defineTool({ name: "get_dashboard", description: "ホームの中身 (承認を待つ物、今日のタスク、費用と推移、サービスの数値) を読む", scope: "read", input: McpNoArgs, route: () => ({ method: "GET", path: "/api/v1/dashboard" }) }),
  defineTool({ name: "list_staff", description: "社員の今の状態を読む", scope: "read", input: McpNoArgs, route: () => ({ method: "GET", path: "/api/v1/staff" }) }),
  defineTool({
    name: "list_tasks",
    description: "タスクを状態か担当の社員で絞って読む",
    scope: "read",
    input: McpTaskArgs,
    route: ({ status, assignee }) => {
      const query = new URLSearchParams({ ...(status ? { status } : {}), ...(assignee ? { assignee } : {}) });
      return { method: "GET", path: `/api/v1/nodes?${query.toString()}` };
    },
  }),
  defineTool({ name: "list_approvals", description: "オーナーの承認を待つ物を読む", scope: "read", input: McpNoArgs, route: () => ({ method: "GET", path: "/api/v1/approvals" }) }),
  defineTool({
    name: "decide_approval",
    description: "承認を待つ物を承認か差し戻しにする。外部連携と費用の増える事の承認はパスキーが要るので、画面で出す",
    scope: "write",
    input: McpDecideArgs,
    route: ({ approvalId, decision, reason }) => ({ method: "POST", path: `/api/v1/approvals/${approvalId}/decision`, body: { decision, reason } }),
  }),
  defineTool({
    name: "send_message",
    description: "社員に発言を送る。社長への発言はタスクになる",
    scope: "write",
    input: McpMessageArgs,
    route: ({ staffId, body }) => ({ method: "POST", path: `/api/v1/staff/${staffId}/messages`, body: { body } }),
  }),
];

/**
 * MCP の連携の鍵を、入力を確かめる前に確かめて置く
 * @throws unauthenticated 鍵が無い、形が違う、知らない、切ってある時
 */
const mcpGate = createMiddleware<GateEnv>(async (c, next) => {
  c.set("mcpClient", await mcpClientOf(c));
  await next();
});

const mcpRoute = createRoute({
  method: "post",
  path: MCP_PATH,
  operationId: "callMcp",
  tags: ["mcp"],
  summary: "MCP の JSON-RPC を 1 件受ける",
  description:
    "MCP の Streamable HTTP の入口。Access の作業用の鍵 (`ACCESS_MCP_CLIENT_ID`) の証明と、設定の画面で作った MCP の連携の鍵を確かめる。道具は画面と同じルートを呼び、ログインセッションを持たないので、パスキーの確認が要る操作は `step_up_required` で断る。",
  security: [{ accessJwt: [], mcpToken: [] }],
  "x-steps": [
    "`Authorization: Bearer` の鍵の SHA-256 で、切っていない `mcp_clients` を読む。5 分ごとに `last_used_at` を書き直す",
    "`initialize`、`ping`、`tools/list` はその場で答える。`tools/list` は鍵の範囲で使える道具だけを返す",
    "`tools/call` は引数を確かめ、鍵の範囲が足りなければ道具の失敗で返す。足りれば画面と同じルートを、ログインセッションの無い要求として呼ぶ",
    "状態を変える道具は、監査ログに `mcp.call` を連携の ID と道具の名前で記録する",
    "id の無い通知は 202 で受けるだけにする",
  ],
  "x-errors": ["401 `unauthenticated`: MCP の連携の鍵が無い、形が違う、知らない、または切ってある。ロックアウトの数に足す"],
  // 本文の形を探らせないよう、入力を確かめる前に連携の鍵で確かめる
  middleware: [mcpGate] as const,
  request: { body: { required: true, content: { "application/json": { schema: McpRequest } } } },
  responses: {
    200: { description: "JSON-RPC の返事", content: { "application/json": { schema: McpResponse } } },
    202: { description: "通知を受けた。レスポンス本文なし" },
    ...problems(400, 401, 403, 413, 415, 422, 429, 500),
  },
});

/** 中で呼ぶ要求ごとに、外の要求の文脈の値を渡す。外から来た要求はここに無いので、中のルートへ届かない */
const INNER = new WeakMap<Request, GateEnv["Variables"]>();

/** 道具が呼ぶルートだけを付けた Hono。外の入口を通らず、外の要求の文脈の値を引き継ぐ */
const inner = createRouter();
inner.use("*", async (c, next) => {
  const vars = INNER.get(c.req.raw);
  if (!vars) throw new AppError("forbidden", "MCP の中からだけ呼べる");
  c.set("traceId", vars.traceId);
  c.set("clock", vars.clock);
  c.set("ip", vars.ip);
  c.set("email", vars.email);
  // ログインセッションが無いので、パスキーの確認が要る操作は step_up_required で断られる
  c.set("session", undefined);
  c.set("fetch", vars.fetch);
  c.set("guard", vars.guard);
  c.set("forge", vars.forge);
  c.set("github", vars.github);
  c.set("archive", vars.archive);
  c.set("deniedCounted", false);
  await next();
});
inner.route("/", dashboardRoutes).route("/", staffRoutes).route("/", nodeRoutes).route("/", orgRoutes).route("/", messageRoutes);
inner.onError(onError);
inner.notFound(notFound);

const Problem = z.looseObject({ code: z.string(), detail: z.string() });
const Data = z.looseObject({ data: z.unknown() });

/**
 * 鍵から切っていない MCP の連携を読む。合わなければロックアウトの数に足して断る
 * @param c 要求の文脈
 * @returns 連携の ID と範囲
 * @throws unauthenticated 鍵が無い、形が違う、知らない、切ってある時
 */
async function mcpClientOf(c: Context<GateEnv>): Promise<{ id: string; scope: McpScope }> {
  const token = /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "")?.[1] ?? "";
  const orm = drizzle(c.env.DB);
  const [row] = TOKEN.test(token)
    ? await orm
        .select({ id: mcpClients.id, scope: mcpClients.scope })
        .from(mcpClients)
        .where(and(eq(mcpClients.tokenHash, await sha256Hex(token)), isNull(mcpClients.revokedAt)))
        .limit(1)
    : [];
  if (!row) {
    await recordLoginFailure(c, "access", "MCP の連携の鍵が合わない");
    throw new AppError("unauthenticated", "MCP の連携の鍵が合わない");
  }
  const now = c.var.clock.now();
  await orm
    .update(mcpClients)
    .set({ lastUsedAt: now })
    .where(and(eq(mcpClients.id, row.id), or(isNull(mcpClients.lastUsedAt), lt(mcpClients.lastUsedAt, now - TOUCH_MS))));
  return row;
}

/**
 * 道具 1 つを、画面と同じルートを中で呼んで動かす
 * @param c 外の要求の文脈
 * @param call 確かめた引数から作ったルート
 * @returns MCP の道具の結果
 */
async function callTool(c: Context<GateEnv>, call: InnerCall): Promise<Record<string, unknown>> {
  const { method, path, body } = call;
  const request = new Request(new URL(path, c.req.url), { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  INNER.set(request, c.var);
  const response = await inner.fetch(request, c.env, executionOf(c));
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return toolResult(JSON.stringify(Data.safeParse(json).data?.data ?? null), false);
  const problem = Problem.safeParse(json);
  const text = problem.success ? `${problem.data.code}: ${problem.data.detail}` : `HTTP ${String(response.status)}`;
  // パスキーは外の AI が持てないので、画面で出すよう返す
  return toolResult(problem.data?.code === "step_up_required" ? `${text}。この操作は know-office の画面でパスキーを確かめて出す` : text, true);
}

/**
 * 要求の実行の文脈を返す。テストのように文脈が無ければ渡さない
 * @param c 要求の文脈
 * @returns 実行の文脈か undefined
 */
function executionOf(c: Context<GateEnv>) {
  try {
    return c.executionCtx;
  } catch {
    // Hono は文脈が無い時に executionCtx を読むと投げる
    return undefined;
  }
}

/**
 * MCP の道具の結果を作る
 * @param text 返す文
 * @param isError 道具の失敗か
 * @returns tools/call の result
 */
function toolResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError };
}

/**
 * JSON-RPC の 1 件に答える
 * @param c 要求の文脈
 * @param message JSON-RPC の要求
 * @param client 確かめた MCP の連携
 * @param client.id 連携の ID
 * @param client.scope 連携の範囲
 * @returns result か error
 */
async function answer(c: Context<GateEnv>, message: McpRequest, client: { id: string; scope: McpScope }): Promise<Pick<McpResponse, "result" | "error">> {
  const allowed = MCP_TOOLS.filter((tool) => tool.scope === "read" || client.scope === "write");
  if (message.method === "initialize") {
    const asked = message.params?.["protocolVersion"];
    const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
    return { result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "know-office", version: "1" } } };
  }
  if (message.method === "ping") return { result: {} };
  if (message.method === "tools/list") {
    return { result: { tools: allowed.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input) })) } };
  }
  if (message.method !== "tools/call") return { error: { code: -32_601, message: `${message.method} は無い` } };
  const tool = MCP_TOOLS.find((t) => t.name === message.params?.["name"]);
  if (!tool) return { error: { code: -32_602, message: "知らない道具" } };
  if (!allowed.includes(tool)) {
    await note(c, client.id, tool.name, "scope");
    return { result: toolResult("forbidden: この MCP の連携は読むだけで、承認と発言はできない", true) };
  }
  const plan = tool.plan(message.params?.["arguments"] ?? {});
  if (!plan.ok) return { result: toolResult(`validation_failed: ${plan.detail}`, true) };
  const result = await callTool(c, plan.call);
  if (tool.scope === "write") await note(c, client.id, tool.name, result["isError"] === true ? "error" : "ok");
  return { result };
}

/**
 * 状態を変える道具の呼び出しと、範囲の外の呼び出しを監査ログに残す。書けなくても道具の結果は返し、エラーログに残す
 * @param c 要求の文脈
 * @param clientId MCP の連携の ID
 * @param tool 道具の名前
 * @param outcome ok、error (ルートが断った)、scope (範囲の外で断った)
 */
async function note(c: Context<GateEnv>, clientId: string, tool: string, outcome: "ok" | "error" | "scope"): Promise<void> {
  // 操作はもう済んでいるので、記録が落ちても外の AI に 500 を返して送り直させない
  await audit(c, "mcp.call", clientId, { tool, outcome }).catch((error: unknown) => log("warn", "mcp_call_not_audited", { traceId: c.var.traceId, error: error instanceof Error ? error.message : "unknown" }));
}

/** MCP の入口のルート */
export const mcpRoutes = router.openapi(mcpRoute, async (c) => {
  const client = c.var.mcpClient;
  if (!client) throw new AppError("unauthenticated", "MCP の連携の鍵が合わない");
  const message = c.req.valid("json");
  // 通知は答えを返さない。MCP の Streamable HTTP の 2.1
  if (message.id === undefined) return c.body(null, 202);
  const answered = await answer(c, message, client);
  // JSON-RPC の返事は MCP の形で返し、{ data, meta } に包まない
  return c.json({ jsonrpc: "2.0" as const, id: message.id, ...answered }, 200);
});
