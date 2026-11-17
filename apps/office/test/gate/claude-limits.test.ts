// Claude の API の使用の上限を見分け、待ちに入れず、待ち直させない印を付けて通知を出す事を、代わりの Claude API で確かめる (サービスと拡張の 3.5)
import { describe, expect, it, vi } from "vitest";
import { spendLimitError } from "../../dev/claude.ts";
import { MINUTE, rows, useGuardWorld } from "../helpers/guard.ts";
import { messages, relayKit, upstream } from "../helpers/relay.ts";

const w = useGuardWorld();

/**
 * 2026-12-09 (日本時間) の時刻を返す。エラーログは年ごとの REC_<年> に入るので、テストの D1 がある 2026 年にする。ほかのファイルと日を分け、5 分の窓を重ねない
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
function at(h: number, m = 0): number {
  return Date.UTC(2026, 11, 9, h - 9, m);
}

const { startTask, callClaude, usageOf, pushSpendLimit, noticesOf, readAll } = relayKit(w, at);

describe("Claude の使用の上限", () => {
  it("組織と workspace の上限の 400 と支払いの 402 も、通知を 1 件出して x-should-retry: false で返し、待ちに入れない", async () => {
    const work = await startTask("builder", 10);
    const labels = { organization: "組織の上限", workspace: "workspace の上限", billing: "支払い" } as const;
    for (const [i, kind] of (["organization", "workspace", "billing"] as const).entries()) {
      w.clock.advance(at(10, 10 + i) - w.clock.now());
      pushSpendLimit(kind);
      // 流れでない要求も同じに読む
      const res = await callClaude(work, { ...messages("直す"), stream: false });
      expect(res.status).toBe(kind === "billing" ? 402 : 400);
      expect(res.headers.get("x-should-retry")).toBe("false");
      expect(await res.json()).toMatchObject({ error: { message: spendLimitError(kind).error.message } });
      expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("working");
      const found = await noticesOf("claude_spend_limit");
      expect(found).toHaveLength(i + 1);
      expect(String(found.at(-1)?.["body"])).toContain(labels[kind]);
      await readAll();
    }
    // 400 は鍵の失敗にしない。どの社員も止める鍵の失敗の通知は出さない
    expect(await rows(w, "SELECT DISTINCT kind FROM notices")).toEqual([{ kind: "claude_spend_limit" }]);
    expect(await usageOf(work.nodeId)).toEqual([]);
  });

  it("使用の上限でない 429 は待ちに入れ、使用の上限の通知を出さない", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 20) - w.clock.now());
    w.gate.claude.pushError(429, "rate_limit_error", { headers: { "retry-after": "10" } });
    const res = await callClaude(work, messages("直す"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(res.headers.get("x-should-retry")).toBeNull();
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("waiting");
    expect(await noticesOf("claude_spend_limit")).toEqual([]);
  });

  it("message の頭が違う 400 と、billing_error でない 402 は、そのまま返して通知を出さない", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 30) - w.clock.now());
    // 頭でなく途中に上限の文がある物も、使用の上限にしない
    w.gate.claude.pushError(400, "invalid_request_error", { message: "max_tokens: You have reached your specified API usage limits" });
    w.gate.claude.pushError(402, "invalid_request_error", { message: "You have reached your specified API usage limits" });
    const bad = await callClaude(work, messages("直す"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("x-should-retry")).toBeNull();
    expect(await bad.json()).toMatchObject({ error: { message: "max_tokens: You have reached your specified API usage limits" } });
    const other = await callClaude(work, messages("直す"));
    expect(other.status).toBe(402);
    expect(other.headers.get("x-should-retry")).toBeNull();
    expect(await rows(w, "SELECT kind FROM notices")).toEqual([]);
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("working");
  });

  it("JSON でない本文と 8KB を超える本文は、ふつうの道で本文を欠かさずに返す", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 40) - w.clock.now());
    const json = { "content-type": "application/json" };
    const text = await callClaude(work, messages("直す"), "/v1/messages", upstream("混み合っている", { status: 429, headers: { "content-type": "text/plain" } }));
    expect(text.status).toBe(429);
    expect(await text.text()).toBe("混み合っている");
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("waiting");
    // 形は使用の上限でも、8KB を超える本文は読まずにふつうの 400 として返す
    const big = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `You have reached your specified API usage limits ${"あ".repeat(3000)}` } });
    const res = await callClaude(work, messages("直す"), "/v1/messages", upstream(big, { status: 400, headers: json }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(big);
    expect(res.headers.get("x-should-retry")).toBeNull();
    expect(await noticesOf("claude_spend_limit")).toEqual([]);
  });

  it("8KB を超える流れの本文は、超えた所で読むのを止め、残りとつないで欠かさずに返す", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 45) - w.clock.now());
    const parts = ["a".repeat(5000), "b".repeat(5000), "c".repeat(5000)];
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[pulled];
        pulled += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(part));
      },
    });
    const res = await callClaude(work, messages("直す"), "/v1/messages", upstream(body, { status: 400, headers: { "content-type": "application/json" } }));
    // 返事を読む前は、8KB を超えた 2 つ目までしか読んでいない
    expect(pulled).toBeLessThanOrEqual(3);
    expect(await res.text()).toBe(parts.join(""));
    expect(await noticesOf("claude_spend_limit")).toEqual([]);
  });

  it("失敗の本文の流れが途中で切れたら、502 で返す", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 47) - w.clock.now());
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("切れた"));
      },
    });
    const res = await callClaude(work, messages("直す"), "/v1/messages", upstream(body, { status: 429, headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(502);
    expect(await noticesOf("claude_spend_limit")).toEqual([]);
  });

  it("同時に 2 つの使用の上限が届いても、通知は 1 件", async () => {
    const work = await startTask("builder", 10);
    w.clock.advance(at(10, 50) - w.clock.now());
    pushSpendLimit("monthly");
    pushSpendLimit("monthly");
    const answers = await Promise.all([callClaude(work, messages("直す")), callClaude(work, messages("直す"))]);
    expect(answers.map((r) => r.status)).toEqual([429, 429]);
    expect(await noticesOf("claude_spend_limit")).toHaveLength(1);
  });

  it("読んだ後にまた届くと、また通知を出し、続いても同じエラーの続きの通知は出さない", async () => {
    const work = await startTask("builder", 11);
    for (let i = 0; i < 5; i += 1) {
      w.clock.advance(at(11, 2 + i) - w.clock.now());
      pushSpendLimit("organization");
      await callClaude(work, messages("直す"));
    }
    expect(await rows(w, "SELECT kind FROM notices")).toEqual([{ kind: "claude_spend_limit" }]);
    await readAll();
    w.clock.advance(at(11, 10) - w.clock.now());
    pushSpendLimit("organization");
    await callClaude(work, messages("直す"));
    expect((await noticesOf("claude_spend_limit")).map((n) => n["read_at"] === null)).toEqual([false, true]);
    const events = await w.d1.REC_2026.prepare("SELECT level, code FROM error_events WHERE at >= ? AND at < ? ORDER BY at").bind(at(11), at(12)).all();
    expect(events.results).toHaveLength(6);
    expect(events.results[0]).toEqual({ level: "warn", code: "claude_spend_limit" });
  });

  it("通知を書けなくても、返事は同じ", async () => {
    const work = await startTask("builder", 11);
    w.clock.advance(at(11, 30) - w.clock.now());
    const db = w.gate.env.DB;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("INSERT INTO notices")) throw new Error("D1 に書けない");
      return prepare(sql);
    });
    pushSpendLimit("billing");
    let res: Response;
    try {
      res = await callClaude(work, messages("直す"));
    } finally {
      vi.restoreAllMocks();
    }
    expect(res.status).toBe(402);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(await res.json()).toMatchObject({ error: { type: "billing_error" } });
    expect(await noticesOf("claude_spend_limit")).toEqual([]);
  });

  it("待っている社員は使用の上限の後も待ちのままで、次の成功で解ける", async () => {
    const work = await startTask("builder", 12);
    w.clock.advance(at(12, 2) - w.clock.now());
    w.gate.claude.pushError(429, "rate_limit_error");
    await callClaude(work, messages("直す"));
    w.clock.advance(at(12, 5) - w.clock.now());
    pushSpendLimit("monthly");
    await callClaude(work, messages("直す"));
    expect((await w.gate.staff.builder.book.status(at(12, 5))).state).toBe("waiting");
    w.clock.advance(at(12, 10) - w.clock.now());
    w.gate.claude.push({ content: [{ type: "text", text: "続けた" }] });
    expect(await (await callClaude(work, messages("直す"))).text()).toContain("続けた");
    expect((await w.gate.staff.builder.book.status(at(12, 10))).state).toBe("working");
    expect(await usageOf(work.nodeId)).toEqual([expect.objectContaining({ waited_ms: 8 * MINUTE })]);
  });

  it("プロキシの 429 は、断った要求の数 (denied_burst) に入れない", async () => {
    const work = await startTask("builder", 12);
    w.clock.advance(at(12, 30) - w.clock.now());
    // 5 分の 50 回の手前までを直に数える。次の 1 回で知らせが出る
    for (let i = 0; i < 50; i += 1) await w.gate.guard.countDenied(w.clock.now());
    w.gate.claude.pushError(429, "rate_limit_error");
    expect((await callClaude(work, messages("直す"))).status).toBe(429);
    expect(await noticesOf("denied_burst")).toEqual([]);
    await w.gate.guard.countDenied(w.clock.now());
    expect(await noticesOf("denied_burst")).toHaveLength(1);
  });
});
