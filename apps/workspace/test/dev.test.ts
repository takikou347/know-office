// 開発の代わりのワークスペースが、本物と同じサーバーで受け、SDK をゲートウェイの開発の道の Claude のプロキシだけに向ける事を確かめる (ログインと記録の 3.9)
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { AgentCall } from "../src/agent.ts";
import { DEV_EVENTS_MAX, rememberEvents, startDevWorkspace } from "../src/dev.ts";

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

  it.each([["http://gate.internal/__dev/workspace/builder"], ["http://10.0.0.1:5174/__dev/workspace/builder"], ["http://localhost:5174/api"]])("ゲートウェイの開発の道が手元でない宛先 (%s) では起こさない", async (gateUrl) => {
    await expect(startDevWorkspace({ key: KEY, gateUrl })).rejects.toMatchObject({ code: "internal" });
  });

  it("手元に残す出来事は最後の 500 回分まで", () => {
    const kept: { kind: "message"; body: string }[][] = [];
    for (let i = 0; i < DEV_EVENTS_MAX + 20; i += 1) rememberEvents(kept, [{ kind: "message", body: String(i) }]);
    expect(kept).toHaveLength(DEV_EVENTS_MAX);
    expect(kept[0]?.[0]?.body).toBe("20");
  });
});
