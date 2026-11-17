// ワークスペースのサーバーが、補完の木の受け取りと切り替えを、ゲートウェイの鍵と木の名前の形を確かめてから受け、1 本だけつなぐ事を確かめる (仕事とレビューの 3.6、社員が考えるの 2 章)
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { KEY, lspServer } from "./helpers/lsp-server.ts";
import { NODE, SHA } from "./helpers/relay.ts";
import { tarGz } from "./helpers/tar.ts";

const GOOD = tarGz([
  { name: "top/", type: "dir" },
  { name: "top/src/a.ts", body: "export const a = 1;\n" },
]);

describe("補完の口", () => {
  const s = lspServer();

  beforeAll(() => s.start());
  afterAll(() => s.stop());
  beforeEach(() => s.reset());
  afterEach(() => s.clean());

  /**
   * 今の木を読む
   * @param nodeId タスク
   * @param key 付ける鍵
   * @returns 返事
   */
  function current(nodeId: string, key: string | null = KEY): Promise<Response> {
    return fetch(`${s.http()}/v1/lsp/trees/${nodeId}`, key === null ? {} : { headers: { authorization: `Bearer ${key}` } });
  }

  it("ゲートウェイの鍵の無い切り替えと木の受け取りは 401 で断る", async () => {
    for (const key of [null, "x".repeat(64), ""]) {
      expect((await s.put(`/v1/lsp/trees/${NODE}/${SHA}`, GOOD, key)).status).toBe(401);
      expect((await current(NODE, key)).status).toBe(401);
    }
    expect(readdirSync(s.base())).toEqual([]);
    expect((await s.put(`/v1/lsp/trees/${NODE}/${SHA}`, GOOD)).status).toBe(204);
    for (const key of [null, "x".repeat(64)]) {
      expect(await s.connect(`?nodeId=${NODE}&sha=${SHA}`, key)).toBe(401);
    }
    expect(s.spawned).toEqual([]);
  });

  it("木の受け取りと切り替えの nodeId が UUID でない、sha が 40 字の小文字の 16 進でない時は 4xx で、ディスクに触れない", async () => {
    const bad: [string, string][] = [
      ["..", SHA],
      ["%2E%2E", SHA],
      [`${NODE}%2F..`, SHA],
      [NODE.toUpperCase(), SHA],
      [NODE, "a".repeat(39)],
      [NODE, "A".repeat(40)],
      [NODE, `${"a".repeat(38)}%2F.`],
      [NODE, ".."],
    ];
    for (const [nodeId, sha] of bad) {
      const status = (await s.put(`/v1/lsp/trees/${nodeId}/${sha}`, GOOD)).status;
      const opened = await s.connect(`?nodeId=${nodeId}&sha=${sha}`);
      expect({ nodeId, sha, put: status >= 400 && status < 500, opened: typeof opened === "number" && opened >= 400 && opened < 500 }).toEqual({ nodeId, sha, put: true, opened: true });
    }
    for (const path of [`/v1/lsp/trees/${NODE}/${SHA}/x`, `/v1/lsp/trees/../${NODE}/${SHA}`, `/v1/lsp/trees/${NODE}`]) {
      expect((await s.put(path, GOOD)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await current(NODE.toUpperCase())).status).toBe(422);
    expect(readdirSync(s.base())).toEqual([]);
    expect(s.spawned).toEqual([]);
  });

  it("木を受けて今のコミットを返し、切り替えで木の tsc につなぐ", async () => {
    expect((await current(NODE)).status).toBe(404);
    // 木の無い切り替えは tsc を起こさずに断る
    expect(await s.connect(`?nodeId=${NODE}&sha=${SHA}`)).toBe(404);
    expect((await s.put(`/v1/lsp/trees/${NODE}/${SHA}`, GOOD)).status).toBe(204);
    expect(await (await current(NODE)).json()).toEqual({ data: { sha: SHA } });
    const client = await s.connect(`?nodeId=${NODE}&sha=${SHA}`);
    if (typeof client === "number") throw new Error(`開けない ${client}`);
    const tree = join(s.root(), NODE, SHA);
    expect(s.spawned).toEqual([tree]);
    client.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { textDocument: { uri: "file:///repo/src/a.ts" }, position: { line: 0, character: 0 } } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.tscs[0]?.received[0]).toMatchObject({ method: "textDocument/hover", params: { textDocument: { uri: `file://${tree}/src/a.ts` } } });
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.tscs[0]?.signals).toEqual(["SIGKILL"]);
  });

  it("2 本目の接続を受けたら前の接続を 1008 で閉じて tsc を止める", async () => {
    expect((await s.put(`/v1/lsp/trees/${NODE}/${SHA}`, GOOD)).status).toBe(204);
    const first = await s.connect(`?nodeId=${NODE}&sha=${SHA}`);
    const second = await s.connect(`?nodeId=${NODE}&sha=${SHA}`);
    if (typeof first === "number" || typeof second === "number") throw new Error("開けない");
    expect(await first.closed).toBe(1008);
    expect(s.tscs.map((tsc) => tsc.signals)).toEqual([["SIGKILL"], []]);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    second.socket.close();
    await second.closed;
  });

  it("1MiB を超える枠を送ってもサーバーが落ちず、接続が 1009 で閉じ、tsc が止まる", async () => {
    expect((await s.put(`/v1/lsp/trees/${NODE}/${SHA}`, GOOD)).status).toBe(204);
    const client = await s.connect(`?nodeId=${NODE}&sha=${SHA}`);
    if (typeof client === "number") throw new Error(`開けない ${client}`);
    // 受け手が誤りを投げても、このテストのプロセスを落とさずに数える
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      client.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didChange", params: { text: "x".repeat(1024 * 1024) } }));
      expect(await client.closed).toBe(1009);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
      expect(s.tscs[0]?.signals).toEqual(["SIGKILL"]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    // サーバーは動いたまま
    expect((await fetch(`${s.http()}/v1/health`)).status).toBe(200);
  });
});
