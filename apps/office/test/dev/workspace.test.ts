// 開発の代わりのワークスペースの置き場が、起こし、Node のサーバーへ要求を回し、受けたタスクの開始を残す事を確かめる (ログインと記録の 3.9)
import { createServer } from "node:http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDevWorkspaces, type StartDevWorkspace } from "../../dev/workspace.ts";

const KEY = "b".repeat(64);
const NODE = "0190f4a8-0000-7000-8000-000000000101";

/**
 * 受けた要求を並べ、/v1/runs に 202 を返す代わりのワークスペースを起こす関数を作る
 * @returns 起こす関数、受けた要求、起こした時の設定、閉じた数
 */
function stubStart(): { start: StartDevWorkspace; seen: string[]; booted: { key: string; anthropicUrl: string }[]; closed: number[] } {
  const seen: string[] = [];
  const booted: { key: string; anthropicUrl: string }[] = [];
  const closed: number[] = [];
  const start: StartDevWorkspace = async (options) => {
    booted.push(options);
    const server = createServer((req, res) => {
      seen.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers.authorization ?? ""}`);
      res.writeHead(req.url === "/v1/runs" ? 202 : 204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("番号が分からない");
    const { port } = address;
    return { port, events: [], close: () => new Promise<void>((resolve) => server.close(() => resolve(void closed.push(1)))) };
  };
  return { start, seen, booted, closed };
}

describe("開発の代わりのワークスペースの置き場", () => {
  it("鍵で起こし、要求を鍵ごと回し、受けたタスクの開始を残し、止めると閉じる", async () => {
    const { start, seen, booted, closed } = stubStart();
    const ws = createDevWorkspaces("http://127.0.0.1:5199/anthropic", start);
    expect((await ws.app.request("/builder/boot", { method: "POST", body: JSON.stringify({ key: KEY }) })).status).toBe(204);
    expect(booted).toEqual([{ key: KEY, anthropicUrl: "http://127.0.0.1:5199/anthropic" }]);
    const res = await ws.app.request("/builder/v1/runs", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify({ nodeId: NODE }) });
    expect(res.status).toBe(202);
    expect(seen).toEqual([`POST /v1/runs Bearer ${KEY}`]);
    expect(await (await ws.app.request("/__fake/runs")).json()).toEqual([{ staffId: "builder", nodeId: NODE }]);
    expect((await ws.app.request("/builder/stop", { method: "POST" })).status).toBe(204);
    expect(closed).toHaveLength(1);
    // 止めた後は届かない
    expect((await ws.app.request("/builder/v1/health")).status).toBe(502);
  });

  it("代わりの物の置き場の /workspace の下に付けても、Node のサーバーへ同じ道で回す", async () => {
    const { start, seen } = stubStart();
    const ws = createDevWorkspaces("http://127.0.0.1:5199/anthropic", start);
    const app = new Hono().route("/workspace", ws.app);
    expect((await app.request("/workspace/builder/boot", { method: "POST", body: JSON.stringify({ key: KEY }) })).status).toBe(204);
    expect((await app.request("/workspace/builder/v1/health")).status).toBe(204);
    expect(seen).toEqual(["GET /v1/health "]);
    await ws.close();
  });

  it("知らない社員と形の違う鍵は起こさない", async () => {
    const { start, booted } = stubStart();
    const ws = createDevWorkspaces("http://127.0.0.1:5199/anthropic", start);
    expect((await ws.app.request("/nobody/boot", { method: "POST", body: JSON.stringify({ key: KEY }) })).status).toBe(400);
    expect((await ws.app.request("/builder/boot", { method: "POST", body: JSON.stringify({ key: "short" }) })).status).toBe(400);
    expect(booted).toEqual([]);
    await ws.close();
  });
});
