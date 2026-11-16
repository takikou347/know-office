// 開発環境の代わりの Claude API を確かめる。ログインと記録の 3.9
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeClaude } from "../../dev/claude.ts";

const HEADERS = { "x-api-key": "test-key", "anthropic-version": "2023-06-01", "content-type": "application/json" };
const REQUEST = { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "こんにちは" }] };
const BODY = JSON.stringify(REQUEST);

/**
 * 社員の作業トークンの形 (JWT) の鍵を作る。代わりの Claude API は署名を確かめず、sub を渡し先を選ぶのにだけ読む
 * @param staffId 社員 ID
 * @returns 鍵
 */
function ticket(staffId: string): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: staffId, node: "n" })).toString("base64url")}.sig`;
}

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

  it("社員を決めて積んだ返事は、その社員の作業トークンの呼び出しにだけ返し、ほかの社員には先に積んだ物があっても渡さない", async () => {
    const claude = createFakeClaude();
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ staffId: "reviewer", content: [{ type: "text", text: "レビュー担当へ" }] }) });
    const call = (key: string) => claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": key }, body: BODY });
    expect((await call(ticket("builder"))).status).toBe(500);
    expect((await call("test-key")).status).toBe(500);
    const res = await call(ticket("reviewer"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "レビュー担当へ" }] });
    // 社員を決めずに積んだ物は、どの呼び出しにも返す
    claude.push({ content: [{ type: "text", text: "誰にでも" }] });
    expect((await call(ticket("builder"))).status).toBe(200);
  });

  it("待ちを付けて積んだ返事は、積んでからその間が過ぎるまで返さず、待つ間に呼び出しが切れたら次の呼び出しに残す", async () => {
    const claude = createFakeClaude();
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ staffId: "reviewer", delay_ms: 200, content: [{ type: "text", text: "待ってから" }] }) });
    const call = (signal?: AbortSignal) => claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": ticket("reviewer") }, body: BODY, ...(signal ? { signal } : {}) });
    // 待つ間に切れた呼び出しには返さず、積んだ物を先頭に戻す
    const gone = new AbortController();
    const first = Promise.resolve(call(gone.signal)).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    gone.abort();
    await first;
    // 呼び直しは、積んでから 200 ミリ秒が過ぎた所で返り、待ちは延びない
    const began = performance.now();
    const res = await call();
    const waited = performance.now() - began;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(190);
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "待ってから" }] });
  });

  it("社員の形でない渡し先を付けて積もうとすると 400 で断る", async () => {
    const claude = createFakeClaude();
    const res = await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ staffId: "nobody", content: [{ type: "text", text: "x" }] }) });
    expect(res.status).toBe(400);
  });

  it("代わりの Claude API は積んだ上限の返事を、その状態と Anthropic の形の失敗で返す", async () => {
    const claude = createFakeClaude();
    claude.pushError(429, "rate_limit_error");
    claude.pushError(529, "overloaded_error");
    const first = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    const second = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    expect(first.status).toBe(429);
    expect(await first.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(second.status).toBe(529);
    expect(claude.requests).toHaveLength(2);
  });

  it("代わりの Claude API は数えるだけの呼び出しに積んだ返事を使わずに答え、届いた鍵を残す", async () => {
    const claude = createFakeClaude();
    const res = await claude.app.request("/v1/messages/count_tokens", { method: "POST", headers: HEADERS, body: BODY });
    expect(await res.json()).toEqual({ input_tokens: expect.any(Number) as unknown });
    expect(claude.keys).toEqual(["test-key"]);
  });

  it("代わりの Claude API はバッチ処理を受け、終えた後に custom_id ごとの結果を JSONL で返す", async () => {
    const claude = createFakeClaude();
    const body = JSON.stringify({ requests: [{ custom_id: "c0", params: REQUEST }, { custom_id: "c1", params: REQUEST }] });
    const created = await claude.app.request("/v1/messages/batches", { method: "POST", headers: HEADERS, body });
    const batch = z.object({ id: z.string(), processing_status: z.string() }).loose().parse(await created.json());
    expect(batch).toMatchObject({ type: "message_batch", processing_status: "in_progress" });
    expect(batch.id).toMatch(/^msgbatch_[A-Za-z0-9]+$/);
    // 終える前は結果を返さない
    expect((await claude.app.request(`/v1/messages/batches/${batch.id}/results`, { headers: HEADERS })).status).toBe(400);
    claude.endBatch(batch.id, (id) => (id === "c0" ? { content: [{ type: "text", text: "案" }] } : "errored"));
    const status = await claude.app.request(`/v1/messages/batches/${batch.id}`, { headers: HEADERS });
    expect(await status.json()).toMatchObject({ id: batch.id, processing_status: "ended", request_counts: { succeeded: 1, errored: 1 } });
    const results = await claude.app.request(`/v1/messages/batches/${batch.id}/results`, { headers: HEADERS });
    const lines = (await results.text()).trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual([
      { custom_id: "c0", result: { type: "succeeded", message: expect.objectContaining({ content: [{ type: "text", text: "案" }] }) as unknown } },
      { custom_id: "c1", result: { type: "errored", error: expect.any(Object) as unknown } },
    ]);
    expect(claude.batches[0]?.requests.map((r) => r.custom_id)).toEqual(["c0", "c1"]);
    // 1 件ずつの Messages API には何も届かない
    expect(claude.requests).toEqual([]);
  });

  it("代わりの Claude API は知らないバッチを 404 で返す", async () => {
    const res = await createFakeClaude().app.request("/v1/messages/batches/msgbatch_none", { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});
