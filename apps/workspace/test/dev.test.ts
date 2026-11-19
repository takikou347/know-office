// 開発の代わりのワークスペースが、本物と同じサーバーで受け、SDK をゲートウェイの開発の道の Claude のプロキシだけに向ける事を確かめる (ログインと記録の 3.9)
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AgentCall } from "../src/agent.ts";
import { DEV_EVENTS_MAX, rememberEvents, startDevWorkspace } from "../src/dev.ts";
import { sessionFile } from "../src/transcript.ts";
import { NODE, parse, SHA } from "./helpers/relay.ts";
import { tarGz } from "./helpers/tar.ts";

const KEY = "a".repeat(64);
const GATE = "http://localhost:5174/__dev/workspace/builder";
const RUN = { nodeId: "0190f4a8-0000-7000-8000-000000000101", ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す", tools: ["ask_boss"] };

describe("開発の代わりのワークスペース", () => {
  it("鍵を付けた /v1/runs を受け、SDK の宛先をゲートウェイの開発の道の Claude のプロキシにし、終わりを手元に残す", async () => {
    const calls: AgentCall[] = [];
    const dev = await startDevWorkspace({
      key: KEY,
      gateUrl: GATE,
      agent: (call) => {
        calls.push(call);
        return Promise.resolve("終えた");
      },
    });
    try {
      const url = `http://127.0.0.1:${String(dev.port)}/v1/runs`;
      expect((await fetch(url, { method: "POST", body: JSON.stringify(RUN) })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(RUN) })).status).toBe(202);
      await expect.poll(() => dev.events.flat().map((e) => e.kind)).toContain("result");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options.env.ANTHROPIC_BASE_URL).toBe(`${GATE}/anthropic`);
    } finally {
      await dev.close();
    }
  });

  it("終わりをゲートウェイの開発の道に作業トークン付きで送り、SDK は手元の作業の置き場とホームで動かし、閉じると消す", async () => {
    const received: { url: string; auth: string; body: string }[] = [];
    const gate = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const address = gate.address();
    if (address === null || typeof address === "string") throw new Error("番号が分からない");
    const calls: AgentCall[] = [];
    const dev = await startDevWorkspace({
      key: KEY,
      gateUrl: `http://127.0.0.1:${String(address.port)}/__dev/workspace/builder`,
      agent: (call) => {
        calls.push(call);
        return Promise.resolve("終えた");
      },
    });
    try {
      const url = `http://127.0.0.1:${String(dev.port)}/v1/runs`;
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(RUN) })).status).toBe(202);
      await expect.poll(() => received.map((r) => r.body).join("")).toContain('"kind":"result"');
      expect(received.every((r) => r.url === "/__dev/workspace/builder/ws/v1/events" && r.auth === "Bearer ticket-1")).toBe(true);
      const { cwd, env } = calls[0]?.options ?? { cwd: "", env: { HOME: "" } };
      expect(existsSync(cwd) && existsSync(env.HOME)).toBe(true);
      await dev.close();
      expect(existsSync(cwd) || existsSync(env.HOME)).toBe(false);
    } finally {
      await dev.close();
      gate.close();
    }
  });

  it("SDK が書いた会話の記録を本物と同じ形でゲートウェイの開発の道に送り、戻した記録から同じ session の続きを呼ぶ", async () => {
    const SESSION = "0190f4a8-0000-7000-8000-00000000c101";
    const line = `{"type":"user","sessionId":"${SESSION}","message":{"role":"user","content":"ログインを直す"}}\n`;
    const received: { url: string; auth: string; body: string }[] = [];
    const gate = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const address = gate.address();
    if (address === null || typeof address === "string") throw new Error("番号が分からない");
    const calls: AgentCall[] = [];
    const seen: string[] = [];
    const dev = await startDevWorkspace({
      key: KEY,
      gateUrl: `http://127.0.0.1:${String(address.port)}/__dev/workspace/builder`,
      agent: async (call) => {
        calls.push(call);
        const file = sessionFile(call.options.env.HOME, call.options.cwd, SESSION);
        // 1 回目は SDK のように記録を書き、続きの 2 回目は戻した記録を読む
        if (call.options.resume === undefined) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, line);
        } else seen.push(readFileSync(file, "utf8"));
        call.onSession(SESSION);
        return "終えた";
      },
    });
    const http = `http://127.0.0.1:${String(dev.port)}`;
    const auth = { authorization: `Bearer ${KEY}` };
    try {
      expect((await fetch(`${http}/v1/runs`, { method: "POST", headers: auth, body: JSON.stringify(RUN) })).status).toBe(202);
      await expect.poll(() => received.filter((r) => r.body.includes('"kind":"result"'))).toHaveLength(1);
      const parts = received.filter((r) => r.url === "/__dev/workspace/builder/ws/v1/transcript-parts");
      expect(parts.map((r) => ({ auth: r.auth, body: JSON.parse(r.body) as unknown }))).toEqual([{ auth: "Bearer ticket-1", body: { sessionId: SESSION, seq: 0, chunk: Buffer.from(line).toString("base64") } }]);

      const restore = { sessionId: SESSION, transcript: Buffer.from(line).toString("base64"), nextSeq: 1 };
      expect((await fetch(`${http}/v1/restore`, { method: "POST", headers: auth, body: JSON.stringify(restore) })).status).toBe(204);
      expect((await fetch(`${http}/v1/runs`, { method: "POST", headers: auth, body: JSON.stringify({ ...RUN, ticket: "ticket-2", resume: SESSION }) })).status).toBe(202);
      await expect.poll(() => received.filter((r) => r.body.includes('"kind":"result"'))).toHaveLength(2);
      expect(calls[1]?.options.resume).toBe(SESSION);
      expect(seen).toEqual([line]);
    } finally {
      await dev.close();
      gate.close();
    }
  });

  it.each([["http://gate.internal/__dev/workspace/builder"], ["http://10.0.0.1:5174/__dev/workspace/builder"], ["http://localhost:5174/api"]])("ゲートウェイの開発の道が手元でない宛先 (%s) では起こさない", async (gateUrl) => {
    await expect(startDevWorkspace({ key: KEY, gateUrl })).rejects.toMatchObject({ code: "internal" });
  });

  it("手元に残す出来事は最後の 500 回分まで", () => {
    const kept: { kind: "message"; body: string }[][] = [];
    for (let i = 0; i < DEV_EVENTS_MAX + 20; i += 1) rememberEvents(kept, [{ kind: "message", body: String(i) }]);
    expect(kept).toHaveLength(DEV_EVENTS_MAX);
    expect(kept[0]?.[0]?.body).toBe("20");
  });

  it("補完の木を受けて今の先を答え、本物の tsc を利用者を落とさずに起こして補完の口を開く", async () => {
    const dev = await startDevWorkspace({ key: KEY, gateUrl: GATE, agent: () => Promise.resolve("終えた") });
    const http = `http://127.0.0.1:${String(dev.port)}`;
    const auth = { authorization: `Bearer ${KEY}` };
    try {
      const tree = tarGz([
        { name: "top/", type: "dir" },
        { name: "top/src/a.ts", body: "export const a = 1;\n" },
      ]);
      expect((await fetch(`${http}/v1/lsp/trees/${NODE}/${SHA}`, { method: "PUT", headers: { ...auth, "content-type": "application/gzip" }, body: new Uint8Array(tree) })).status).toBe(204);
      expect(await (await fetch(`${http}/v1/lsp/trees/${NODE}`, { headers: auth })).json()).toMatchObject({ data: { sha: SHA } });
      const socket = new WebSocket(`ws://127.0.0.1:${String(dev.port)}/v1/lsp?nodeId=${NODE}&sha=${SHA}`, { headers: auth });
      const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on("message", (data: Buffer) => {
          const message = parse(data.toString("utf8"));
          if (message.id === 1) resolve(message);
        });
        socket.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("unexpected-response", (_req, res) => reject(new Error(`開けない ${String(res.statusCode)}`)));
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: 1, rootUri: "file:///work", capabilities: {} } }));
      expect(await answer).toHaveProperty("result.capabilities");
      socket.close();
    } finally {
      await dev.close();
    }
  }, 20_000);
});
