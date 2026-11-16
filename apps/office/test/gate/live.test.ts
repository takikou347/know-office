// 配信のルート。作業トークンは 60 秒のうちに 1 回だけ、Origin は自分だけで、違う時は作業トークンを使い切らない。配る出来事は決めた形だけ (社員と自動の 3.7、ルートの一覧の 1.6)
import { LiveEvent, Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { announce } from "../../src/gate/live/publish.ts";
import { LIVE_TICKET_LIMIT } from "../../src/gate/live/tickets.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, ORIGIN, OWNER, type TestGate } from "../helpers/gate.ts";

const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 10, 16, h - 9, m, s);

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  clock = fixedClock(at(10));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const Ticket = z.object({ data: z.object({ ticket: z.string(), expiresAt: z.string() }) });

/**
 * 作業トークンを出させる
 * @returns 作業トークン
 */
async function ticket(): Promise<string> {
  const res = await gate.request("/api/v1/live/tickets", { method: "POST", headers });
  expect(res.status).toBe(201);
  return Ticket.parse(await res.json()).data.ticket;
}

/**
 * WebSocket に切り替えに行く
 * @param value 作業トークン
 * @param extra 足すヘッダー。Origin を null にすると付けない
 * @returns 返事
 */
function open(value: string | null, extra: Record<string, string | null> = {}) {
  const sent: Record<string, string> = { ...headers, Upgrade: "websocket" };
  for (const [name, v] of Object.entries(extra)) {
    if (v === null) delete sent[name];
    else sent[name] = v;
  }
  return gate.request(`/api/v1/live${value === null ? "" : `?ticket=${encodeURIComponent(value)}`}`, { headers: sent });
}

describe("配信の作業トークン", () => {
  it("作業トークンは 43 字の base64url で、記憶には SHA-256 だけを置く", async () => {
    const value = await ticket();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await open(value)).status).toBe(200);
    expect(gate.live.opened).toHaveLength(1);
    expect(gate.live.opened[0]?.headers.get("x-live-session")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("作業トークンは 1 回だけ使え、同時に 2 つ開いても 1 つだけ通る", async () => {
    const value = await ticket();
    const replies = await Promise.all([open(value), open(value)]);
    expect(replies.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 401]);
    expect((await open(value)).status).toBe(401);
  });

  it("59 秒台は通り、60 秒ちょうどと超えは 401", async () => {
    const first = await ticket();
    const second = await ticket();
    const third = await ticket();
    clock.advance(59_999);
    expect((await open(first)).status).toBe(200);
    clock.advance(1);
    expect(Problem.parse(await (await open(second)).json()).code).toBe("unauthenticated");
    clock.advance(1);
    expect((await open(third)).status).toBe(401);
  });

  it("使える作業トークンは 20 枚までで、切れた物は数えない", async () => {
    for (let n = 0; n < LIVE_TICKET_LIMIT; n += 1) await ticket();
    const over = await gate.request("/api/v1/live/tickets", { method: "POST", headers });
    expect(over.status).toBe(429);
    expect(Problem.parse(await over.json()).code).toBe("rate_limited");
    clock.advance(60_000);
    headers = await gate.signIn();
    expect((await gate.request("/api/v1/live/tickets", { method: "POST", headers })).status).toBe(201);
  });

  it("ログインセッションの無い作業トークンの要求は 401", async () => {
    const res = await gate.request("/api/v1/live/tickets", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": headers["Cf-Access-Jwt-Assertion"] ?? "", Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect((await gate.request("/api/v1/live/tickets", { method: "POST", headers: { Origin: ORIGIN } })).status).toBe(401);
  });
});

describe("配信の切り替えの守り", () => {
  it("Origin が無い、null、別のポート、自分の名前で始まる別の所、末尾の違う所、https に変えた所の時は 403 で、作業トークンを使い切らない", async () => {
    const origins = [null, "null", "http://localhost:8080", "http://localhost.evil.com", "http://localhost/", "https://localhost"];
    const answers: Record<string, string> = {};
    for (const origin of origins) {
      const value = await ticket();
      const res = await open(value, { Origin: origin });
      // 断った後も、同じ作業トークンで開ける
      answers[String(origin)] = `${String(res.status)} ${Problem.parse(await res.json()).code} ${String((await open(value)).status)}`;
    }
    expect(answers).toEqual(Object.fromEntries(origins.map((o) => [String(o), "403 origin_mismatch 200"])));
  });

  it("作業トークンが無く Origin も違う時は 403、形の違う作業トークンは 401、Upgrade が無ければ 400 で使い切らない", async () => {
    expect((await open(null, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await open(null)).status).toBe(422);
    expect((await open("x".repeat(44))).status).toBe(401);
    const value = await ticket();
    const res = await open(value, { Upgrade: null });
    expect(res.status).toBe(400);
    expect((await open(value)).status).toBe(200);
  });

  it("作業トークンを返事、エラーログ、監査ログに出さない", async () => {
    const value = await ticket();
    await open(value);
    const res = await open(value);
    const body = await res.text();
    expect(body).not.toContain(value);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(JSON.stringify(gate.audits)).not.toContain(value);
    const errors = await d1.REC_2026.prepare("SELECT * FROM error_events").all();
    expect(JSON.stringify(errors.results)).not.toContain(value);
  });

  it("ログアウトすると、そのログインセッションの配信を閉じさせる", async () => {
    const me = z.object({ data: z.array(z.object({ id: z.string(), current: z.boolean() }).loose()) }).parse(await (await gate.request("/api/v1/sessions", { headers })).json());
    const id = me.data.find((s) => s.current)?.id ?? "";
    expect((await gate.request(`/api/v1/sessions/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(gate.live.closed).toEqual([id]);
  });
});

describe("配る出来事", () => {
  it("決めた形の出来事だけを配り、形の違う物は配らずエラーログに残す", async () => {
    await announce(gate.env, { type: "notice", notice: { id: "019a7b00-0000-7000-8000-0000000000f1" } }, clock);
    await announce(gate.env, { type: "notice", notice: { id: "019a7b00-0000-7000-8000-0000000000f2", title: "鍵 sk-ant-xxx" } }, clock);
    await announce(gate.env, { type: "staff", staff: { id: "builder", state: "working", nodeId: null, workedMsToday: 1 } }, clock);
    expect(gate.live.published).toEqual([{ type: "notice", notice: { id: "019a7b00-0000-7000-8000-0000000000f1" } }]);
    const errors = (await d1.REC_2026.prepare("SELECT source, code FROM error_events").all()).results;
    expect(errors).toEqual([
      { source: "live_do", code: "live_event_invalid" },
      { source: "live_do", code: "live_event_invalid" },
    ]);
  });

  it("どのフレームにも、/staff と /dashboard にも、オーナーのメールと鍵と作業トークンが無い", async () => {
    await gate.request("/api/v1/staff/builder/messages", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body: "こんにちは" }) });
    await gate.staff.builder.book.wake(at(9));
    const value = await ticket();
    const frames = JSON.stringify(gate.live.published);
    const staff = await (await gate.request("/api/v1/staff", { headers })).text();
    const dashboard = await (await gate.request("/api/v1/dashboard", { headers })).text();
    for (const text of [frames, staff, dashboard]) {
      expect(text).not.toContain(OWNER);
      expect(text).not.toContain(value);
      expect(text).not.toMatch(/sk-ant|ghs_|MASTER_KEY/);
    }
    for (const frame of gate.live.published) expect(LiveEvent.safeParse(frame).success).toBe(true);
  });
});
