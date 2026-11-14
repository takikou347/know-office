// ログインセッションを作る、一覧、切る、守り (ログインと記録の 3.2、ルートの一覧の 1.2)
import { Me, Session } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, OWNER, type TestGate } from "../helpers/gate.ts";

const HOUR = 60 * 60_000;
let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
// テストごとに空の D1 とゲートウェイを作り、時刻も初めに戻す
beforeEach(async () => {
  // 日本時間の 12 時。深夜のログインの通知を出さない時刻
  clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
});
afterEach(() => d1.dispose());

const SessionList = z.object({ data: z.array(Session), meta: z.object({ traceId: z.string(), next: z.string().nullable() }) });

/**
 * 時刻を進めた後も通る Access の証明に差し替える。代わりの Access の証明は 1 時間で切れる
 * @param headers ログインのヘッダー
 * @returns 証明を出し直したヘッダー
 */
async function fresh(headers: Record<string, string>): Promise<Record<string, string>> {
  return { ...headers, "Cf-Access-Jwt-Assertion": await gate.access.sign() };
}

describe("セッション", () => {
  it("ログインセッションを作ると __Host- の HttpOnly、Secure、SameSite=Strict のクッキーを置き、監査ログに残す", async () => {
    const res = await gate.request("/api/v1/sessions", {
      method: "POST",
      headers: { Origin: "http://localhost", "Cf-Access-Jwt-Assertion": await gate.access.sign(), "CF-IPCountry": "JP", "User-Agent": "test" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-ko_session=[\w-]+\.[\w-]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/);
    const { data } = z.object({ data: Session }).parse(await res.json());
    expect(res.headers.get("Location")).toBe(`/api/v1/sessions/${data.id}`);
    expect(data).toMatchObject({ current: true, country: "JP", userAgent: "test", endedAt: null });
    expect(gate.audits.map((a) => a.action)).toEqual(["session.create"]);
  });

  it("セッションを切る", async () => {
    const pc = await gate.signIn();
    const phone = await gate.signIn();
    const { data } = SessionList.parse(await (await gate.request("/api/v1/sessions", { headers: pc })).json());
    expect(data).toHaveLength(2);
    const phoneId = data.find((s) => !s.current)?.id ?? "";
    expect((await gate.request(`/api/v1/sessions/${phoneId}`, { method: "DELETE", headers: pc })).status).toBe(204);
    // その端末の次の要求は断られる
    expect((await gate.request("/api/v1/me", { headers: phone })).status).toBe(401);
    expect((await gate.request("/api/v1/me", { headers: pc })).status).toBe(200);
    expect((await gate.request(`/api/v1/sessions/${phoneId}`, { method: "DELETE", headers: pc })).status).toBe(404);
  });

  it("今のセッションを切るとクッキーを消させ、ほかを全部切ると今のセッションだけが残る", async () => {
    const a = await gate.signIn();
    await gate.signIn();
    const b = await gate.signIn();
    expect((await gate.request("/api/v1/sessions", { method: "DELETE", headers: a })).status).toBe(204);
    expect((await gate.request("/api/v1/me", { headers: b })).status).toBe(401);
    const { data } = SessionList.parse(await (await gate.request("/api/v1/sessions", { headers: a })).json());
    expect(data.map((s) => s.current)).toEqual([true]);
    const me = Me.parse(z.object({ data: Me }).parse(await (await gate.request("/api/v1/me", { headers: a })).json()).data);
    const res = await gate.request(`/api/v1/sessions/${me.sessionId}`, { method: "DELETE", headers: a });
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-ko_session=; .*Max-Age=0$/);
    expect(gate.audits.map((x) => x.action)).toEqual(["session.create", "session.create", "session.create", "session.end_others", "session.end"]);
  });

  it("ログイン中の人を返す", async () => {
    const headers = await gate.signIn();
    const { data } = z.object({ data: Me }).parse(await (await gate.request("/api/v1/me", { headers })).json());
    expect(data).toMatchObject({ email: OWNER, stepUpUntil: null, hasPasskey: false });
  });

  it("一覧は limit ごとにページを送る", async () => {
    const headers = await gate.signIn();
    for (let n = 0; n < 2; n += 1) {
      clock.advance(1);
      await gate.signIn();
    }
    const first = SessionList.parse(await (await gate.request("/api/v1/sessions?limit=2", { headers })).json());
    expect(first.data).toHaveLength(2);
    const second = SessionList.parse(await (await gate.request(`/api/v1/sessions?limit=2&cursor=${first.meta.next ?? ""}`, { headers })).json());
    expect(second.data).toHaveLength(1);
    expect(second.meta.next).toBeNull();
    expect((await gate.request("/api/v1/sessions?limit=0", { headers })).status).toBe(422);
    expect((await gate.request("/api/v1/sessions?unknown=1", { headers })).status).toBe(400);
  });

  it("D1 にはトークンのハッシュだけを置く", async () => {
    const headers = await gate.signIn();
    const token = (headers["Cookie"] ?? "").split("=")[1]?.split(".")[0] ?? "";
    const { results } = await d1.DB.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(results[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("署名を書き換えたクッキーは 401", async () => {
    const headers = await gate.signIn();
    const cookie = headers["Cookie"] ?? "";
    const res = await gate.request("/api/v1/me", { headers: { ...headers, Cookie: `${cookie.slice(0, -2)}AA` } });
    expect(res.status).toBe(401);
  });

  it.each(["a", "!!", ""])("署名が base64url として壊れたクッキー「%s」も 500 でなく 401", async (signature) => {
    const headers = await gate.signIn();
    const token = (headers["Cookie"] ?? "").split(".")[0] ?? "";
    const res = await gate.request("/api/v1/me", { headers: { ...headers, Cookie: `${token}.${signature}` } });
    expect(res.status).toBe(401);
  });

  it("2 時間操作が無いと切れる。操作があれば続く", async () => {
    const headers = await gate.signIn();
    clock.advance(HOUR + 59 * 60_000);
    expect((await gate.request("/api/v1/me", { headers: await fresh(headers) })).status).toBe(200);
    clock.advance(HOUR + 59 * 60_000);
    expect((await gate.request("/api/v1/me", { headers: await fresh(headers) })).status).toBe(200);
    clock.advance(2 * HOUR);
    expect((await gate.request("/api/v1/me", { headers: await fresh(headers) })).status).toBe(401);
  });

  it("12 時間で切れる", async () => {
    const headers = await gate.signIn();
    for (let n = 0; n < 11; n += 1) {
      clock.advance(HOUR);
      expect((await gate.request("/api/v1/me", { headers: await fresh(headers) })).status).toBe(200);
    }
    clock.advance(HOUR);
    expect((await gate.request("/api/v1/me", { headers: await fresh(headers) })).status).toBe(401);
  });
});

/**
 * 国を決めてログインセッションを作る
 * @param country CF-IPCountry
 * @returns 返事
 */
async function login(country: string): Promise<Response> {
  return gate.request("/api/v1/sessions", { method: "POST", headers: { Origin: "http://localhost", "Cf-Access-Jwt-Assertion": await gate.access.sign(), "CF-IPCountry": country } });
}

describe("総当たりと怪しい動き", () => {
  it("新しい国からのログイン", async () => {
    await login("JP");
    await login("JP");
    await login("US");
    const { results } = await d1.DB.prepare("SELECT kind, body FROM notices ORDER BY rowid").all<{ kind: string; body: string }>();
    // 初めてのログインは比べる国が無いので知らせない
    expect(results.map((r) => r.kind)).toEqual(["unusual_login"]);
    expect(results[0]?.body).toContain("新しい国 (US)");
  });

  it("日本時間の 0 時から 6 時のログインは通知を出す", async () => {
    clock.advance(14 * HOUR);
    await gate.signIn();
    const { results } = await d1.DB.prepare("SELECT body FROM notices").all<{ body: string }>();
    expect(results.at(-1)?.body).toContain("0 時から 6 時");
  });
});
