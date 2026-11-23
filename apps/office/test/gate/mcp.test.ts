// 外の AI が MCP で know-office を読み、承認と発言を出す。鍵は画面で作って切る (ログインと記録の 3.10)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asked, statusOf, stepUp } from "../helpers/approvals.ts";
import { api, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/** テストの Access の作業用の鍵の Client ID */
const MCP_CLIENT_ID = "mcp-client.access";

const Created = z.object({ client: z.object({ id: z.string() }).loose(), token: z.string() }).strict();
const Rpc = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.looseObject({}).optional(), error: z.looseObject({}).optional() }).strict();
const ToolOut = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean() }).strict();

/**
 * パスキーで確かめてから MCP の連携を作る
 * @param w テストの物
 * @param scope read か write
 * @returns 連携の ID と鍵
 */
async function connect(w: WorkWorld, scope: "read" | "write"): Promise<{ id: string; token: string }> {
  await stepUp(w);
  const { client, token } = Created.parse(await api(w, "POST", "/api/v1/mcp-clients", { name: "Claude のプロジェクト", scope }, 201));
  return { id: client.id, token };
}

/**
 * 外の AI として MCP の入口に JSON-RPC を 1 件送る
 * @param w テストの物
 * @param token MCP の連携の鍵。null なら付けない
 * @param method JSON-RPC のメソッド
 * @param params JSON-RPC の引数
 * @returns 返事
 */
async function rpc(w: WorkWorld, token: string | null, method: string, params: Record<string, unknown> = {}): Promise<Response> {
  w.gate.env.ACCESS_MCP_CLIENT_ID = MCP_CLIENT_ID;
  // Access の作業用の鍵で通った証明は email を持たず、common_name に Client ID を持つ。外の AI は Origin もクッキーも送らない
  const proof = await w.gate.access.sign({ email: undefined, sub: "", common_name: MCP_CLIENT_ID });
  return w.gate.request("/api/v1/mcp", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": proof, "Content-Type": "application/json", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/**
 * 道具を呼び、道具の結果を返す
 * @param w テストの物
 * @param token MCP の連携の鍵
 * @param name 道具の名前
 * @param args 引数
 * @returns 道具の結果
 */
async function call(w: WorkWorld, token: string, name: string, args: Record<string, unknown> = {}): Promise<z.infer<typeof ToolOut>> {
  const res = await rpc(w, token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return ToolOut.parse(Rpc.parse(await res.json()).result);
}

describe("外の AI から MCP で操作する", () => {
  it("鍵の無い MCP の要求", async () => {
    expect((await rpc(world, null, "tools/list")).status).toBe(401);
    expect((await rpc(world, "ko_mcp_".padEnd(50, "a"), "tools/list")).status).toBe(401);
    // 失敗はロックアウトの数に足す
    expect(await rows(world.d1.DB, "SELECT kind FROM login_attempts WHERE ok = 0")).toHaveLength(2);
    // Access の作業用の鍵が設定に無ければ、正しい鍵でも通さない
    const { token } = await connect(world, "read");
    world.gate.env.ACCESS_MCP_CLIENT_ID = undefined;
    const proof = await world.gate.access.sign({ email: undefined, sub: "", common_name: MCP_CLIENT_ID });
    const res = await world.gate.request("/api/v1/mcp", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": proof, "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("MCP の鍵を作って切る", async () => {
    // 作るのはパスキーの確認が要る
    await api(world, "POST", "/api/v1/mcp-clients", { name: "x", scope: "read" }, 401);
    const { id, token } = await connect(world, "read");
    expect(token).toMatch(/^ko_mcp_[\w-]{43}$/);
    // サーバーには鍵そのものを置かない
    expect(JSON.stringify(await rows(world.d1.DB, "SELECT * FROM mcp_clients"))).not.toContain(token);
    expect(JSON.stringify(await api(world, "GET", "/api/v1/mcp-clients"))).not.toContain(token);
    expect((await rpc(world, token, "ping")).status).toBe(200);
    expect((await world.gate.request(`/api/v1/mcp-clients/${id}`, { method: "DELETE", headers: world.headers })).status).toBe(204);
    expect(await rows(world.d1.DB, "SELECT revoked_at FROM mcp_clients WHERE revoked_at IS NOT NULL")).toHaveLength(1);
    // 二度は切れない
    await api(world, "DELETE", `/api/v1/mcp-clients/${id}`, undefined, 404);
  });

  it("切った MCP の鍵", async () => {
    const { id, token } = await connect(world, "write");
    await world.gate.request(`/api/v1/mcp-clients/${id}`, { method: "DELETE", headers: world.headers });
    expect((await rpc(world, token, "tools/list")).status).toBe(401);
  });

  it("MCP から社員と承認待ちを読む", async () => {
    const { token } = await connect(world, "read");
    const init = Rpc.parse(await (await rpc(world, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).json());
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const listed = Rpc.parse(await (await rpc(world, token, "tools/list")).json());
    // 読むだけの鍵には状態を変える道具を見せない
    expect(z.object({ tools: z.array(z.looseObject({ name: z.string() })) }).parse(listed.result).tools.map((t) => t.name)).toEqual(["get_dashboard", "list_staff", "list_tasks", "list_approvals"]);
    const staff = await call(world, token, "list_staff");
    expect(staff.isError).toBe(false);
    expect(staff.content[0]?.text).toContain("builder");
    expect(await call(world, token, "list_approvals")).toMatchObject({ isError: false, content: [{ text: "[]" }] });
    expect(await call(world, token, "get_dashboard")).toMatchObject({ isError: false });
    expect(await call(world, token, "list_tasks", { assignee: "builder" })).toMatchObject({ isError: false });
  });

  it("読むだけの鍵で承認する", async () => {
    const { approvalId } = await asked(world, "external_integration");
    const { token } = await connect(world, "read");
    const out = await call(world, token, "decide_approval", { approvalId, decision: "reject", reason: "要らない" });
    expect(out).toMatchObject({ isError: true });
    expect(out.content[0]?.text).toContain("forbidden");
    expect(await statusOf(world, "approvals", approvalId)).toBe("pending");
    // 範囲の外の呼び出しも監査ログに残す
    expect(world.gate.audits.filter((a) => a.action === "mcp.call")).toMatchObject([{ detail: { tool: "decide_approval", outcome: "scope" } }]);
  });

  it("MCP から外部連携を承認する", async () => {
    const { approvalId } = await asked(world, "external_integration");
    const { id, token } = await connect(world, "write");
    // 画面のログインセッションがパスキーで確かめていても、MCP はパスキーを持たないので画面と同じく断る
    const out = await call(world, token, "decide_approval", { approvalId, decision: "approve", reason: "使う" });
    expect(out).toMatchObject({ isError: true });
    expect(out.content[0]?.text).toContain("step_up_required");
    expect(await statusOf(world, "approvals", approvalId)).toBe("pending");
    // 差し戻しは守りを弱めないので、画面と同じく通る
    expect(await call(world, token, "decide_approval", { approvalId, decision: "reject", reason: "今は要らない" })).toMatchObject({ isError: false });
    expect(await statusOf(world, "approvals", approvalId)).toBe("rejected");
    expect(world.gate.audits.filter((a) => a.action === "mcp.call")).toMatchObject([
      { target: id, detail: { tool: "decide_approval", outcome: "error" } },
      { target: id, detail: { tool: "decide_approval", outcome: "ok" } },
    ]);
  });

  it("MCP から社員に発言する", async () => {
    const { token } = await connect(world, "write");
    expect(await call(world, token, "send_message", { staffId: "builder", body: "今日は通知を先に" })).toMatchObject({ isError: false });
    expect(JSON.stringify(await api(world, "GET", "/api/v1/staff/builder/messages"))).toContain("今日は通知を先に");
    // 道に入るのは確かめた社員 ID だけ
    expect(await call(world, token, "send_message", { staffId: "../guard", body: "x" })).toMatchObject({ isError: true });
  });

  it("Access の作業用の鍵は MCP の入口だけを通す", async () => {
    world.gate.env.ACCESS_MCP_CLIENT_ID = MCP_CLIENT_ID;
    world.gate.env.ACCESS_SMOKE_CLIENT_ID = "smoke-client.access";
    const mcpProof = await world.gate.access.sign({ email: undefined, sub: "", common_name: MCP_CLIENT_ID });
    // MCP の鍵の証明は、ほかのルートとログインセッションの作成を通らない
    expect((await world.gate.request("/api/v1/staff", { headers: { "Cf-Access-Jwt-Assertion": mcpProof } })).status).toBe(401);
    expect((await world.gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": mcpProof } })).status).toBe(401);
    expect((await world.gate.request("/api/v1/sessions", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": mcpProof, Origin: "http://localhost" } })).status).toBe(401);
    expect((await world.gate.request("/api/v1/mcp", { headers: { "Cf-Access-Jwt-Assertion": mcpProof } })).status).toBe(401);
    // 稼働確認の鍵の証明は MCP の入口を通らない
    const { token } = await connect(world, "read");
    const smokeProof = await world.gate.access.sign({ email: undefined, sub: "", common_name: "smoke-client.access" });
    const res = await world.gate.request("/api/v1/mcp", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": smokeProof, "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(res.status).toBe(401);
  });

  it("鍵の長さの境目と、壊れた本文", async () => {
    const { token } = await connect(world, "read");
    expect((await rpc(world, token.slice(0, -1), "ping")).status).toBe(401);
    expect((await rpc(world, `${token}a`, "ping")).status).toBe(401);
    expect((await rpc(world, token, "ping")).status).toBe(200);
    world.gate.env.ACCESS_MCP_CLIENT_ID = MCP_CLIENT_ID;
    const proof = await world.gate.access.sign({ email: undefined, sub: "", common_name: MCP_CLIENT_ID });
    const headers = { "Cf-Access-Jwt-Assertion": proof, "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    expect((await world.gate.request("/api/v1/mcp", { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await world.gate.request("/api/v1/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x".repeat(1024 * 1024) }) })).status).toBe(413);
    // 通知は答えを返さない
    const note = await world.gate.request("/api/v1/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
  });

  it("使うのと切るのが同時に来る", async () => {
    const { id, token } = await connect(world, "read");
    const [used] = await Promise.all([rpc(world, token, "ping"), world.gate.request(`/api/v1/mcp-clients/${id}`, { method: "DELETE", headers: world.headers })]);
    // 切る前に読んだ要求は通ってよいが、切った後の要求は必ず断る
    expect([200, 401]).toContain(used.status);
    expect((await rpc(world, token, "ping")).status).toBe(401);
    expect(await rows(world.d1.DB, "SELECT id FROM mcp_clients WHERE revoked_at IS NULL")).toEqual([]);
  });
});
