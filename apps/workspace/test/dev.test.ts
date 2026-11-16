// 開発の代わりのワークスペースが、本物と同じサーバーで受け、SDK を手元の代わりの Claude API だけに向ける事を確かめる (ログインと記録の 3.9)
import { describe, expect, it } from "vitest";
import type { AgentCall } from "../src/agent.ts";
import { startDevWorkspace } from "../src/dev.ts";

const KEY = "a".repeat(64);
const RUN = { nodeId: "0190f4a8-0000-7000-8000-000000000101", ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す", tools: ["ask_boss"] };

describe("開発の代わりのワークスペース", () => {
  it("鍵を付けた /v1/runs を受け、SDK の宛先を代わりの Claude API にし、終わりを手元に残す", async () => {
    const calls: AgentCall[] = [];
    const dev = await startDevWorkspace({
      key: KEY,
      anthropicUrl: "http://localhost:5199/anthropic",
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
      expect(calls[0]?.options.env.ANTHROPIC_BASE_URL).toBe("http://localhost:5199/anthropic");
    } finally {
      await dev.close();
    }
  });

  it.each([["https://api.anthropic.com"], ["http://10.0.0.1:5199/anthropic"], ["http://localhost:5199"]])("手元の代わりでない宛先 (%s) では起こさない", async (anthropicUrl) => {
    await expect(startDevWorkspace({ key: KEY, anthropicUrl })).rejects.toMatchObject({ code: "internal" });
  });
});
