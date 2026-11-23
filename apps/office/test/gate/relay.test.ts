// Claude のプロキシを、作業トークンから代わりの Claude API、使った量の記録、勤怠の待ちまで確かめる (社員が考えるの 3.4、テスト設計の社員が考える)
import { DEV_STAFF_HEADER, type Fetcher } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import { type Caller, routeEgress } from "../../src/gate/egress.ts";
import { claudeBlocked } from "../../src/gate/work/run.ts";
import { workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { ANTHROPIC_KEY } from "../helpers/gate.ts";
import { MINUTE, rows, useGuardWorld } from "../helpers/guard.ts";
import { messages, relayKit, SYSTEM, upstream } from "../helpers/relay.ts";

const w = useGuardWorld();

/**
 * 2026-12-07 (日本時間、月曜) の時刻を返す。usage は年ごとの REC_<年> に入るので、テストの D1 がある 2026 年にする
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
function at(h: number, m = 0): number {
  return Date.UTC(2026, 11, 7, h - 9, m);
}

const { startTask, callClaude, usageOf, pushSpendLimit, noticesOf, readAll } = relayKit(w, at);

const encoder = new TextEncoder();

/**
 * 流れの返事の出来事を 1 つ作る
 * @param event 出来事の名前
 * @param data 中身
 * @returns SSE の 1 つの出来事
 */
function sse(event: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

/** 流れの頭。入力 40 と出力 1 を持つ */
const START = sse("message_start", {
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 1 } },
});

/** 流れの途中の文 */
const DELTA = sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "途中" } });

describe("トークンを減らす", () => {
  it("読み直しの割引", async () => {
    const work = await startTask();
    // 1 回目は先頭を書き込み、5 分以内の 2 回目はその先頭を割引で読む
    w.gate.claude.push({ content: [{ type: "text", text: "読んだ" }], usage: { input_tokens: 50, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 } });
    w.gate.claude.push({ content: [{ type: "text", text: "直した" }], usage: { input_tokens: 60, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } });
    const first = await callClaude(work, messages("読む"));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("読んだ");
    w.clock.advance(at(9, 4) - w.clock.now());
    const second = await callClaude(work, messages("直す"));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("直した");
    // 先頭の変わらない部分は、プロキシが変えずに同じ形で送る
    expect(w.gate.claude.requests.map((r) => r["system"])).toEqual([SYSTEM, SYSTEM]);
    // 当たりはタスクごとに残る。費用は開発担当のモデルの単価 (入力 2、出力 10、読み直し 0.1、書き込み 2.5 ドル / 百万) から出す
    expect(await usageOf(work.nodeId)).toEqual([
      expect.objectContaining({ staff_id: "builder", scope: "office", model: "claude-sonnet-5-5", input_tokens: 50, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 2000, cost_micro_usd: 6100, waited_ms: null }),
      expect.objectContaining({ staff_id: "builder", scope: "office", model: "claude-sonnet-5-5", input_tokens: 60, output_tokens: 80, cache_read_tokens: 2000, cache_write_tokens: 0, cost_micro_usd: 1120, waited_ms: null }),
    ]);
  });
});

describe("落ちても続きから", () => {
  it("API の上限", async () => {
    const work = await startTask();
    w.clock.advance(at(9, 30) - w.clock.now());
    w.gate.claude.pushError(429, "rate_limit_error");
    const limited = await callClaude(work, messages("直す"));
    // 待ち直しは SDK に任せるので、上限の返事はそのまま返し、勤怠は待っている状態に入る
    expect(limited.status).toBe(429);
    expect((await w.gate.staff.builder.book.status(at(9, 30))).state).toBe("waiting");
    expect(await usageOf(work.nodeId)).toEqual([]);
    // 15 分後に通ったら待ちを解き、同じタスクの続きを行う
    w.clock.advance(at(9, 45) - w.clock.now());
    w.gate.claude.push({ content: [{ type: "text", text: "続けた" }] });
    const resumed = await callClaude(work, messages("直す"));
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain("続けた");
    expect((await w.gate.staff.builder.book.status(at(9, 45))).state).toBe("working");
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ node_id: work.nodeId, waited_ms: 15 * MINUTE })]);
    expect(await rows(w, "SELECT kind, started_at, ended_at, reason FROM attendance WHERE kind = 'waiting'")).toEqual([
      { kind: "waiting", started_at: at(9, 30), ended_at: at(9, 45), reason: "rate_limit" },
    ]);
  });

  it("費用の上限に届く", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 5) - w.clock.now());
    pushSpendLimit("monthly");
    // ワークスペースの SDK は流れで頼む。上限の返事は流れの前の JSON で返る
    const limited = await callClaude(work, messages("直す"));
    expect(limited.status).toBe(429);
    // 待っても直らないので、SDK に待ち直させず、社員を待ちに入れない
    expect(limited.headers.get("x-should-retry")).toBe("false");
    expect(await limited.json()).toMatchObject({ error: { details: { error_code: "enforced_spend_limit_reached" } } });
    expect((await w.gate.staff.builder.book.status(at(10, 5))).state).toBe("working");
    const [notice] = await noticesOf("claude_spend_limit");
    expect(notice).toMatchObject({ level: "stop", read_at: null });
    expect(String(notice?.["body"])).toContain("月の使用の上限");
    expect(String(notice?.["body"])).toContain("You have reached your API usage limits");
    // 読むまでどの社員も呼び出しを始めず、読むと始める
    expect(await claudeBlocked(w.gate.env.DB)).toBe(true);
    await readAll();
    expect(await claudeBlocked(w.gate.env.DB)).toBe(false);
  });
});

describe("Claude のプロキシ", () => {
  it("混み合いの 529 も待っていた時間に入れる", async () => {
    const work = await startTask();
    w.gate.claude.pushError(529, "overloaded_error");
    expect((await callClaude(work, messages("直す"))).status).toBe(529);
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("waiting");
  });

  it("作業トークンを Anthropic の鍵に替えて送り、鍵を返事にも記録にも出さない", async () => {
    const work = await startTask();
    w.gate.claude.push({ content: [{ type: "text", text: "返す" }] });
    const res = await callClaude(work, { ...messages("直す"), stream: false });
    expect(res.status).toBe(200);
    expect(w.gate.claude.keys).toEqual([ANTHROPIC_KEY]);
    const text = await res.text();
    expect(text).not.toContain(ANTHROPIC_KEY);
    expect([...res.headers.values()].join(" ")).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(await usageOf(work.nodeId))).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(w.gate.audits)).not.toContain(ANTHROPIC_KEY);
    // 流れでない返事も、使った量を残す
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ input_tokens: 10, output_tokens: 10, cost_micro_usd: 120, request_id: null })]);
  });

  it("開発環境だけ、代わりの Claude API が社員を見分ける印を付けて送り、ほかの環境では付けない", async () => {
    const work = await startTask();
    const seen: (string | null)[] = [];
    const capture: Fetcher = (_url, init) => {
      seen.push(new Headers(init?.headers).get(DEV_STAFF_HEADER));
      return Promise.resolve(Response.json({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    expect((await callClaude(work, { ...messages("直す"), stream: false }, "/v1/messages", capture)).status).toBe(200);
    const was = w.gate.env.ENVIRONMENT;
    try {
      for (const environment of ["production", "preview", undefined]) {
        w.gate.env.ENVIRONMENT = environment;
        expect((await callClaude(work, { ...messages("直す"), stream: false }, "/v1/messages", capture)).status).toBe(200);
      }
    } finally {
      w.gate.env.ENVIRONMENT = was;
    }
    expect(seen).toEqual(["builder", null, null, null]);
  });

  it("ワークスペースが呼び出しを切ったら、Claude API への呼び出しも切り、Claude の API の失敗に数えない", async () => {
    // エラーログの 5 分の窓をほかのテストと分ける
    const work = await startTask("builder", 15);
    const gone = new AbortController();
    let upstreamAborted = false;
    const reached: (() => void)[] = [];
    const called = new Promise<void>((resolve) => reached.push(resolve));
    // Claude API は返事を返さずに待ち、ゲートウェイが切った時だけ終える
    const hanging: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        for (const done of reached) done();
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(new DOMException("切れた", "AbortError"));
        });
      });
    const call = Promise.resolve(callClaude(work, messages("直す"), "/v1/messages", hanging, gone.signal)).catch(() => null);
    await called;
    gone.abort();
    await call;
    expect(upstreamAborted).toBe(true);
    const failures = await w.d1.REC_2026.prepare("SELECT code FROM error_events WHERE at >= ? AND at < ?").bind(at(15), at(16)).all();
    expect(failures.results).toEqual([]);
  });

  it("止まっている社員の呼び出しは 409 stopped で断り、外へ出さない", async () => {
    const work = await startTask();
    await w.d1.DB.prepare("INSERT INTO stops (id, at, kind, scope, target, signal, measured, threshold, rules_version, by) VALUES (?, ?, 'stop', 'staff', 'builder', 'tool_rate', 1, 1, 1, 'system')")
      .bind(crypto.randomUUID(), at(9))
      .run();
    const res = await callClaude(work, messages("直す"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "stopped" });
    // SDK が待ち直さないよう、やり直さない印を付ける
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(w.gate.claude.requests).toEqual([]);
  });

  it("役で許していないモデルは 403 で断り、軽いタスクのモデルは通す", async () => {
    const work = await startTask();
    const denied = await callClaude(work, messages("直す", "claude-opus-5-5"));
    expect(denied.status).toBe(403);
    expect(w.gate.claude.requests).toEqual([]);
    w.gate.claude.push({ content: [{ type: "text", text: "軽い" }] });
    const light = await callClaude(work, messages("題を付ける", "claude-haiku-5-5"));
    expect(light.status).toBe(200);
    // 使った量は流れを読み終えた所で残る
    expect(await light.text()).toContain("軽い");
    // 軽いタスクのモデルは 0.1、0.5 ドル / 百万で、入力 10 と出力 10 は 6 になる
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ model: "claude-haiku-5-5", cost_micro_usd: 6 })]);
  });

  it("作業トークンのモデルと Haiku だけを通し、作業中に社員のモデルを変えても同じ作業は通る", async () => {
    const work = await startTask("builder", 9, "claude-sonnet-5-5");
    await w.d1.DB.prepare("UPDATE staff SET model = 'claude-opus-5-5' WHERE id = 'builder'").run();
    w.gate.claude.push({ content: [{ type: "text", text: "続ける" }] });
    expect((await callClaude(work, messages("続ける", "claude-sonnet-5-5"))).status).toBe(200);
    expect((await callClaude(work, messages("替える", "claude-opus-5-5"))).status).toBe(403);
    w.gate.claude.push({ content: [{ type: "text", text: "軽い" }] });
    expect((await callClaude(work, messages("題を付ける", "claude-haiku-5-5"))).status).toBe(200);
  });

  it("モデルの無い古い作業トークンは社員の行のモデルで確かめる", async () => {
    const work = await startTask("builder", 9);
    await w.d1.DB.prepare("UPDATE staff SET model = 'claude-opus-5-5' WHERE id = 'builder'").run();
    expect((await callClaude(work, messages("前のモデル", "claude-sonnet-5-5"))).status).toBe(403);
    w.gate.claude.push({ content: [{ type: "text", text: "今のモデル" }] });
    expect((await callClaude(work, messages("今のモデル", "claude-opus-5-5"))).status).toBe(200);
  });

  it("数えるだけの呼び出しは送るが、使った量には残さない", async () => {
    const work = await startTask();
    const res = await callClaude(work, { model: "claude-sonnet-5-5", system: SYSTEM, messages: [{ role: "user", content: "数える" }] }, "/v1/messages/count_tokens");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: expect.any(Number) as unknown });
    expect(w.gate.claude.keys).toEqual([ANTHROPIC_KEY]);
    expect(await usageOf(work.nodeId)).toEqual([]);
  });

  it("ほかの道と形の違う本文は外へ出さずに断る", async () => {
    const work = await startTask();
    expect((await callClaude(work, messages("直す"), "/v1/messages/batches")).status).toBe(404);
    expect((await callClaude(work, { messages: [] })).status).toBe(422);
    expect(w.gate.claude.keys).toEqual([]);
  });

  it("waitEnd が落ちても返事と使った量が残る", async () => {
    const work = await startTask();
    vi.spyOn(w.gate.staff.builder.book, "waitEnd").mockRejectedValue(new Error("社員 DO に届かない"));
    w.gate.claude.push({ content: [{ type: "text", text: "返す" }] });
    const res = await callClaude(work, messages("直す"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("返す");
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ input_tokens: 10, output_tokens: 10, waited_ms: null })]);
  });

  it("429 の後に 500 が来ても待ちは解けない", async () => {
    const work = await startTask();
    w.gate.claude.pushError(429, "rate_limit_error");
    w.gate.claude.pushError(500, "api_error");
    expect((await callClaude(work, messages("直す"))).status).toBe(429);
    expect((await callClaude(work, messages("直す"))).status).toBe(500);
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("waiting");
    expect(await usageOf(work.nodeId)).toEqual([]);
  });

  it("ワークスペースが流れを途中で切っても、届いた所までの量を 1 度だけ残す", async () => {
    const work = await startTask();
    // 頭と文を 1 つ送った後は終わらない流れ
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(START);
        controller.enqueue(DELTA);
      },
    });
    const res = await callClaude(work, messages("直す"), "/v1/messages", upstream(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("message_start");
    await reader?.cancel();
    await reader?.cancel();
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ input_tokens: 40, output_tokens: 1, cost_micro_usd: 90 })]);
  });

  it("ワークスペースが流れを切った後の記録は waitUntil に渡し、返事の後も最後まで走らせる", async () => {
    const work = await startTask();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(START);
      },
    });
    const later: Promise<unknown>[] = [];
    await w.gate.staff[work.staffId].book.heartbeat(w.clock.now());
    const caller: Caller = { staffId: work.staffId, workspaceId: workspaceIdOf(w.gate.env, work.staffId) };
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": work.token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(messages("直す")),
    });
    const fetcher = upstream(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const res = await routeEgress(request, w.gate.env, caller, { clock: w.clock, guard: w.gate.deps, fetch: fetcher, waitUntil: (p) => later.push(p) });
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    // 切った要求が終わった後に走る記録は、受け手の waitUntil に渡した 1 本だけ
    expect(later).toHaveLength(1);
    await Promise.all(later);
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ input_tokens: 40 })]);
  });

  it("Claude API が流れの途中で落ちても、届いた所までの量を残す", async () => {
    const work = await startTask();
    let sent = 0;
    // 頭を送った次に落ちる流れ。10 分の時間切れも同じく読み出しの失敗になる
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent === 1) controller.enqueue(START);
        else controller.error(new Error("切れた"));
      },
    });
    const res = await callClaude(work, messages("直す"), "/v1/messages", upstream(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await expect(res.text()).rejects.toThrow("切れた");
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ input_tokens: 40, output_tokens: 1 })]);
  });

  it("返すヘッダーは上限の物と要求 ID だけで、組織の ID を出さない", async () => {
    const work = await startTask();
    const answer = JSON.stringify({ model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 10 } });
    const headers = { "content-type": "application/json", "request-id": "req_1", "anthropic-organization-id": "org-1", "anthropic-ratelimit-requests-remaining": "99" };
    const res = await callClaude(work, { ...messages("直す"), stream: false }, "/v1/messages", upstream(answer, { status: 200, headers }));
    expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("99");
    expect(res.headers.get("request-id")).toBe("req_1");
    expect(res.headers.get("anthropic-organization-id")).toBeNull();
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ request_id: "req_1" })]);
  });

  it("費用と記録のモデルは、確かめて許した要求のモデルで引く", async () => {
    const work = await startTask();
    // 返事のモデルの名前が単価表と違っても、要求のモデルの単価で数える
    const answer = JSON.stringify({ model: "claude-sonnet-5-5-20261101", usage: { input_tokens: 10, output_tokens: 10 } });
    await callClaude(work, { ...messages("直す"), stream: false }, "/v1/messages", upstream(answer, { status: 200, headers: { "content-type": "application/json" } }));
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ model: "claude-sonnet-5-5", cost_micro_usd: 120 })]);
  });

  it("1 時間の読み直しの書き込みは 2 倍の単価で数え、書き込みの数は合計で残す", async () => {
    const work = await startTask();
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 } };
    const answer = JSON.stringify({ model: "claude-sonnet-5-5", usage });
    await callClaude(work, { ...messages("直す"), stream: false }, "/v1/messages", upstream(answer, { status: 200, headers: { "content-type": "application/json" } }));
    // 5 分は 2.5、1 時間は 4 ドル / 百万
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ cache_write_tokens: 3000, cost_micro_usd: 2000 * 2.5 + 1000 * 4 })]);
  });
});
