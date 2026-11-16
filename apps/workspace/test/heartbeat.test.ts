// ワークスペースが 30 秒ごとにゲートウェイへハートビートを送る事を確かめる (社員と勤怠の 3.5)
import type { Fetcher } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import { GATE_HEARTBEAT_URL, HEARTBEAT_EVERY_MS, startHeartbeat } from "../src/heartbeat.ts";

describe("ハートビート", () => {
  it("30 秒ごとに送った時刻を送り、送れなくても止まらず、前の送りが終わるまで重ねない", async () => {
    const ticks: (() => void)[] = [];
    const seen: unknown[] = [];
    const box = { release: (_r: Response) => {} };
    const replies: Promise<Response>[] = [Promise.reject(new Error("届かない")), new Promise((resolve) => (box.release = resolve))];
    const fetcher: Fetcher = (url, init) => {
      seen.push([url, typeof init?.body === "string" ? JSON.parse(init.body) : null]);
      return replies.shift() ?? Promise.resolve(new Response(null, { status: 204 }));
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startHeartbeat({ fetcher, clock: { now: () => Date.UTC(2026, 10, 16, 0, 0, 0) }, every: (fn, ms) => (ticks.push(fn), expect(ms).toBe(HEARTBEAT_EVERY_MS), () => {}) });
    expect(HEARTBEAT_EVERY_MS).toBe(30_000);
    // 起きてすぐ 1 回送る
    await Promise.resolve();
    expect(seen).toEqual([[GATE_HEARTBEAT_URL, { at: "2026-11-16T00:00:00.000Z" }]]);
    await new Promise((r) => setTimeout(r, 0));
    ticks[0]?.();
    expect(seen).toHaveLength(2);
    // 2 回目が返る前の 3 回目は送らない
    ticks[0]?.();
    expect(seen).toHaveLength(2);
    box.release(new Response(null, { status: 204 }));
    await new Promise((r) => setTimeout(r, 0));
    ticks[0]?.();
    expect(seen).toHaveLength(3);
    warn.mockRestore();
    stop();
  });
});
