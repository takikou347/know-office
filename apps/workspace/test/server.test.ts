// ワークスペースの Node のサーバーが、社員 DO からの起動確認、タスクの開始、作業トークンの差し替えを受ける事を確かめる (社員が考えるの 1.3)
import { health, WORKSPACE_KEY_ENV } from "@know-office/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCall } from "../src/agent.ts";
import { Runner } from "../src/run.ts";
import { createWorkspaceServer, takeWorkspaceKey } from "../src/server.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const KEY = "a".repeat(64);
const RUN = { nodeId: NODE, ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す" };

describe("ワークスペース", () => {
  const calls: AgentCall[] = [];
  const runner = new Runner((call) => {
    calls.push(call);
    call.onSession("session-1");
    return new Promise((_resolve, reject) => {
      call.options.abortController.signal.addEventListener("abort", () => reject(call.options.abortController.signal.reason));
    });
  }, () => {});
  const server = createWorkspaceServer(runner, KEY);
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("ワークスペースの番号が取れない");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  /**
   * JSON の本文を付けて呼ぶ
   * @param method メソッド
   * @param path 道
   * @param body 本文
   * @param key 付ける鍵。省くとゲートウェイの鍵
   * @returns 返事
   */
  function send(method: string, path: string, body: unknown, key: string | null = KEY): Promise<Response> {
    const auth: Record<string, string> = key === null ? {} : { authorization: `Bearer ${key}` };
    return fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
  }

  it("/v1/health がワークスペースの様子を返す", async () => {
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: health("workspace") });
  });

  it("タスクを受けて 202 を返し、走っている間の 2 つ目は 409 を返す", async () => {
    expect((await send("POST", "/v1/runs", RUN)).status).toBe(202);
    expect(calls).toHaveLength(1);
    const again = await send("POST", "/v1/runs", RUN);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "conflict" });
  });

  it("作業トークンを差し替える", async () => {
    expect((await send("PUT", "/v1/ticket", { ticket: "ticket-2" })).status).toBe(204);
    expect(runner.token()).toBe("ticket-2");
  });

  it("形の違う入力は 422 を返し、知らない道は 404 を返す", async () => {
    expect((await send("POST", "/v1/runs", { ...RUN, extra: 1 })).status).toBe(422);
    expect((await send("PUT", "/v1/ticket", { ticket: "" })).status).toBe(422);
    expect((await fetch(`${base}/nothing`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404);
    // 鍵の無い要求には、道の有る無しを見せない
    expect((await fetch(`${base}/nothing`)).status).toBe(401);
  });

  describe("ワークスペースを分ける", () => {
    it("社員がワークスペースのサーバーを鍵無しで呼ぶ", async () => {
      const before = { calls: calls.length, token: runner.token() };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const key of [null, "b".repeat(64), "a", ""]) {
        for (const [method, path, body] of [
          ["POST", "/v1/runs", RUN],
          ["PUT", "/v1/ticket", { ticket: "ticket-x" }],
        ] as const) {
          const res = await send(method, path, body, key);
          expect({ key, path, status: res.status }).toEqual({ key, path, status: 401 });
          expect(await res.json()).toMatchObject({ code: "unauthenticated" });
        }
      }
      // タスクも作業トークンも変わらない
      expect({ calls: calls.length, token: runner.token() }).toEqual(before);
      // 断った事を残す。中身と Authorization は出さない
      const lines = warn.mock.calls.map(([line]) => String(line));
      warn.mockRestore();
      expect(lines.map((line) => JSON.parse(line) as unknown).slice(0, 2)).toEqual([
        { level: "warn", event: "workspace_unauthenticated", method: "POST", route: "/v1/runs" },
        { level: "warn", event: "workspace_unauthenticated", method: "PUT", route: "/v1/ticket" },
      ]);
      expect(lines).toHaveLength(8);
      expect(lines.join("\n")).not.toMatch(/bbbb|Bearer|ticket-x|ログインを直す/);
    });
  });
});

describe("ワークスペースの鍵", () => {
  it("起こした時の鍵を環境変数から取り出して消し、社員が動かす子のプロセスに渡さない", () => {
    const env: Record<string, string | undefined> = { [WORKSPACE_KEY_ENV]: KEY, PATH: "/usr/bin" };
    expect(takeWorkspaceKey(env)).toBe(KEY);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("鍵が無ければ空を返し、サーバーはどの要求も断る", async () => {
    expect(takeWorkspaceKey({})).toBe("");
    const server = createWorkspaceServer(new Runner(() => Promise.resolve(), () => {}), "");
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("ワークスペースの番号が取れない");
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/ticket`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " }, body: JSON.stringify({ ticket: "t" }) });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
