// 開発環境の代わりの Claude API を確かめる。ログインと記録の 3.9
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeSpendLimit, DEV_STAFF_HEADER, SPEND_LIMIT_KINDS } from "@know-office/core";
import { createFakeClaude, spendLimitError } from "../../dev/claude.ts";

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
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    claude.push({ content: [{ type: "text", text: "1 つ目" }] });
    claude.push({ content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }], stop_reason: "tool_use" });
    const first = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    const second = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    expect(await first.json()).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "1 つ目" }], stop_reason: "end_turn" });
    expect(await second.json()).toMatchObject({ content: [{ type: "tool_use", name: "read_file" }], stop_reason: "tool_use" });
    expect(claude.requests).toHaveLength(2);
    expect(claude.requests[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("代わりの Claude API の使用の上限の返事は、本物と同じ形で読める", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    for (const kind of SPEND_LIMIT_KINDS) {
      const { status, type, ...extra } = spendLimitError(kind).error;
      claude.pushError(status, type, extra);
      const res = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
      expect(res.status).toBe(status);
      // ゲートウェイが本物の返事を見分けるのと同じ Zod を通す
      expect(claudeSpendLimit(res.status, await res.json())).toMatchObject({ kind });
    }
    // ふつうのレートの上限は使用の上限にしない
    claude.pushError(429, "rate_limit_error");
    const rate = await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    expect(claudeSpendLimit(rate.status, await rate.json())).toBeNull();
  });

  it("代わりの Claude API は、切り替えた社員の呼び出しにだけ使用の上限を返し続け、戻すと積んだ返事を返す", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    const limit = (body: unknown) => claude.app.request("/__fake/limit", { method: "POST", body: JSON.stringify(body) });
    expect((await limit({ staffId: "reviewer", limit: "monthly" })).status).toBe(204);
    expect((await limit({ staffId: "nobody", limit: "monthly" })).status).toBe(400);
    claude.push({ content: [{ type: "text", text: "開発担当へ" }] });
    claude.push({ content: [{ type: "text", text: "戻った" }] });
    const call = (staffId: string) => claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": ticket(staffId) }, body: BODY });
    for (let i = 0; i < 2; i += 1) expect((await call("reviewer")).status).toBe(429);
    expect(await (await call("builder")).json()).toMatchObject({ content: [{ text: "開発担当へ" }] });
    expect((await limit({ staffId: "reviewer", limit: null })).status).toBe(204);
    expect(await (await call("reviewer")).json()).toMatchObject({ content: [{ text: "戻った" }] });
  });

  it("代わりの Claude API は鍵が無ければ 401 を返す", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    claude.push({ content: [{ type: "text", text: "返さない" }] });
    const res = await claude.app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: BODY });
    expect(res.status).toBe(401);
  });

  it("代わりの Claude API は通す鍵と作業トークンのほかを本物と同じく 401 で断り、通す鍵を替えられる", async () => {
    const claude = createFakeClaude({ keys: ["test-key"] });
    claude.push({ content: [{ type: "text", text: "通す" }] });
    const send = (key: string) => claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": key }, body: BODY });
    const wrong = await send("other-key");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect((await send(ticket("builder"))).status).toBe(401);
    expect((await claude.app.request("/v1/messages/batches/msgbatch_none", { headers: { ...HEADERS, "x-api-key": "other-key" } })).status).toBe(401);
    await claude.app.request("/__fake/keys", { method: "PUT", body: JSON.stringify({ keys: ["new-key"] }) });
    expect(await (await claude.app.request("/__fake/keys")).json()).toEqual({ keys: ["new-key"] });
    expect((await send("test-key")).status).toBe(401);
    expect((await send("new-key")).status).toBe(200);
  });

  it("代わりの Claude API は積んだ返事が無ければ 500 で知らせる", async () => {
    const res = await createFakeClaude({ keys: ["test-key"], workTokens: true }).app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("返事が積まれていない");
  });

  it("代わりの Claude API は stream で SSE の出来事を順に返す", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
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
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "外から" }] }) });
    await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY });
    const res = await claude.app.request("/__fake/requests");
    expect(await res.json()).toMatchObject([{ model: "claude-opus-5-5" }]);
  });

  it("社員を決めて積んだ返事は、その社員の作業トークンの呼び出しにだけ返し、ほかの社員には先に積んだ物があっても渡さない", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
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

  it("鍵が作業トークンでない時は、開発のプロキシが付けた社員の印で積んだ返事を選び、作業トークンの社員を印より先に使う", async () => {
    const claude = createFakeClaude({ keys: ["dev-fake-anthropic-key"], workTokens: true });
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ staffId: "reviewer", content: [{ type: "text", text: "レビュー担当へ" }] }) });
    const call = (key: string, staffId: string) => claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": key, [DEV_STAFF_HEADER]: staffId }, body: BODY });
    // 作業トークンの社員は印より先に使うので、印が reviewer でも builder には渡さない
    expect((await call(ticket("builder"), "reviewer")).status).toBe(500);
    // 社員の形でない印は使わない
    expect((await call("dev-fake-anthropic-key", "nobody")).status).toBe(500);
    const res = await call("dev-fake-anthropic-key", "reviewer");
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "レビュー担当へ" }] });
  });

  it("使用の上限に切り替えた社員は、開発のプロキシが付けた社員の印でも見分ける", async () => {
    const claude = createFakeClaude({ keys: ["dev-fake-anthropic-key"], workTokens: true });
    await claude.app.request("/__fake/limit", { method: "POST", body: JSON.stringify({ staffId: "reviewer", limit: "monthly" }) });
    const res = await claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": "dev-fake-anthropic-key", [DEV_STAFF_HEADER]: "reviewer" }, body: BODY });
    expect(res.status).toBe(429);
  });

  it("ゲートウェイ向けに積んだ返事は、作業トークンでない鍵の呼び出しにだけ先に返し、社員には渡さない", async () => {
    const claude = createFakeClaude();
    claude.push({ content: [{ type: "text", text: "社員へ" }] });
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "ゲートウェイへ" }], forGate: true }) });
    const staff = await claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": ticket("reviewer") }, body: BODY });
    expect(await staff.json()).toMatchObject({ content: [{ text: "社員へ" }] });
    // 社員の呼び出しはゲートウェイ向けの物を取らない
    expect((await claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": ticket("reviewer") }, body: BODY })).status).toBe(500);
    expect(await (await claude.app.request("/v1/messages", { method: "POST", headers: HEADERS, body: BODY })).json()).toMatchObject({ content: [{ text: "ゲートウェイへ" }] });
  });

  it("待ちを付けて積んだ返事は、積んでからその間が過ぎるまで返さず、待つ間に呼び出しが切れたら次の呼び出しに残す", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
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

  it("待ちを付けて積んだ返事を待つ間に、同じ社員の呼び直しが来たら呼び直しに渡し、前の呼び出しには返さない", async () => {
    // ゲートウェイのプロキシを通ると、SDK が切った呼び出しが代わりの Claude API に切れたと届かない。呼び直しが来た事で前の呼び出しを捨てる
    const claude = createFakeClaude({ keys: ["dev-fake-anthropic-key"], workTokens: true });
    await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ staffId: "reviewer", delay_ms: 200, content: [{ type: "text", text: "待ってから" }] }) });
    const call = () => claude.app.request("/v1/messages", { method: "POST", headers: { ...HEADERS, "x-api-key": "dev-fake-anthropic-key", [DEV_STAFF_HEADER]: "reviewer" }, body: BODY });
    const first = call();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = call();
    expect((await first).status).toBe(499);
    const res = await second;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "待ってから" }] });
  });

  it("社員の形でない渡し先を付けて積もうとすると 400 で断る", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    const res = await claude.app.request("/__fake/responses", { method: "POST", body: JSON.stringify({ staffId: "nobody", content: [{ type: "text", text: "x" }] }) });
    expect(res.status).toBe(400);
  });

  it("代わりの Claude API は積んだ上限の返事を、その状態と Anthropic の形の失敗で返す", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
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
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
    const res = await claude.app.request("/v1/messages/count_tokens", { method: "POST", headers: HEADERS, body: BODY });
    expect(await res.json()).toEqual({ input_tokens: expect.any(Number) as unknown });
    expect(claude.keys).toEqual(["test-key"]);
  });

  it("代わりの Claude API はバッチ処理を受け、終えた後に custom_id ごとの結果を JSONL で返す", async () => {
    const claude = createFakeClaude({ keys: ["test-key"], workTokens: true });
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
    const res = await createFakeClaude({ keys: ["test-key"], workTokens: true }).app.request("/v1/messages/batches/msgbatch_none", { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});
