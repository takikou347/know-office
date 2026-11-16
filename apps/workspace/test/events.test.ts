// 働いた事 (発言、終わり、エラー) をゲートウェイの POST /ws/v1/events に届ける口を確かめる (社員が考えるの 3.2、3.7)
import type { AgentEvent, Fetcher } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import { GATE_EVENTS_URL, gateReporter } from "../src/events.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const SAID: AgentEvent = { kind: "message", body: "直した" };
const DONE: AgentEvent = { kind: "result", nodeId: NODE, result: "done" };

/**
 * 送った本文から出来事の並びを取り出す
 * @param body 本文
 * @returns 出来事の並び。形が違えば undefined
 */
function eventsOf(body: unknown): unknown {
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : null;
  return typeof parsed === "object" && parsed !== null && "events" in parsed ? parsed.events : undefined;
}

/**
 * 届かない返事を作る
 * @returns 失敗する Promise
 */
const down = () => Promise.reject(new Error("届かない"));

/**
 * ゲートウェイの代わり。決めた順に返事を返し、受けた本文を並べる
 * @param replies 返事の並び。尽きたら 204
 * @returns fetch の代わりと受けた物
 */
function gate(replies: (() => Promise<Response>)[]) {
  const seen: { url: string; authorization: string | null; events: unknown }[] = [];
  const fetcher: Fetcher = (url, init) => {
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), events: eventsOf(init?.body) });
    return replies.shift()?.() ?? Promise.resolve(new Response(null, { status: 204 }));
  };
  return { fetcher, seen };
}

describe("働いた事をゲートウェイに届ける", () => {
  it("作業トークンを付けて送り、発言と終わりを分けて送る", async () => {
    const { fetcher, seen } = gate([]);
    await gateReporter({ fetcher, wait: () => Promise.resolve() }).report("ticket-1", [SAID, DONE]);
    expect(seen).toEqual([
      { url: GATE_EVENTS_URL, authorization: "Bearer ticket-1", events: [SAID] },
      { url: GATE_EVENTS_URL, authorization: "Bearer ticket-1", events: [DONE] },
    ]);
  });

  it("発言は届かなくても送り直さず、終わりは 3 回まで送り直す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher, seen } = gate([down, down, down, down]);
    await gateReporter({ fetcher, wait: () => Promise.resolve() }).report("ticket-1", [SAID, DONE]);
    warn.mockRestore();
    expect(seen.map((s) => s.events)).toEqual([[SAID], [DONE], [DONE], [DONE]]);
  });

  it("終わりが 409 で断られたら送り直さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher, seen } = gate([() => Promise.resolve(Response.json({ code: "conflict" }, { status: 409 }))]);
    await gateReporter({ fetcher, wait: () => Promise.resolve() }).report("ticket-1", [DONE]);
    warn.mockRestore();
    expect(seen).toHaveLength(1);
  });
});
