// 開発環境の代わりの Claude API を確かめる。ログインと記録の 3.9
import { describe, expect, it } from "vitest";
import { createFakeClaude } from "../../dev/claude.ts";

const HEADERS = { "x-api-key": "test-key", "anthropic-version": "2023-06-01", "content-type": "application/json" };
const REQUEST = { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "こんにちは" }] };
const BODY = JSON.stringify(REQUEST);

describe("開発環境の代わりの物", () => {
  it("代わりの Claude API は積んだ返事を順に返し、届いた要求を残す", async () => {
    const claude = createFakeClaude();
    claude.push({ content: [{ type: "text", text: "1 つ目" }] });
    claude.push({ content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }], stop_reason: "tool_use" });
    const first = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    const second = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    expect(await first.json()).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "1 つ目" }], stop_reason: "end_turn" });
    expect(await second.json()).toMatchObject({ content: [{ type: "tool_use", name: "read_file" }], stop_reason: "tool_use" });
    expect(claude.requests).toHaveLength(2);
    expect(claude.requests[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("代わりの Claude API は鍵が無ければ 401 を返す", async () => {
    const claude = createFakeClaude();
    claude.push({ content: [{ type: "text", text: "返さない" }] });
    const res = await claude.app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
    expect(res.status).toBe(401);
  });

  it("代わりの Claude API は積んだ返事が無ければ 500 で知らせる", async () => {
    const res = await createFakeClaude().app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("返事が積まれていない");
  });

  it("代わりの Claude API は stream で SSE の出来事を順に返す", async () => {
    const claude = createFakeClaude();
    claude.push({ content: [{ type: "text", text: "流す" }] });
    const res = await claude.app.request("/v1/messages", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ ...REQUEST, stream: true }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = [...(await res.text()).matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  });

  it("代わりの Claude API は /__fake/ で返事を積み、届いた要求を読める", async () => {
    const claude = createFakeClaude();
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "外から" }] }) });
    await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    const res = await claude.app.request("/__fake/requests");
    expect(await res.json()).toMatchObject([{ model: "claude-opus-5-5" }]);
  });
});
