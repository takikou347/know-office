// 入れるのはオーナーだけ。Access の証明、ロックアウト、レート制限、Origin を確かめる (ログインと記録の 3.1、API の決まりの 1.2、3.2)
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, ORIGIN, type TestGate } from "../helpers/gate.ts";

const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
let d1: TestD1;
let gate: TestGate;
// テストごとに空の D1 とゲートウェイを作り、前のテストの失敗の数に頼らない
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
});
afterEach(() => d1.dispose());

/**
 * 失敗の code を読む
 * @param res 返事
 * @returns problem+json の code
 */
async function codeOf(res: Response): Promise<string> {
  return Problem.parse(await res.json()).code;
}

describe("入れるのはオーナーだけ", () => {
  it("Access を通らない要求", async () => {
    const res = await gate.request("/api/v1/health");
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("unauthenticated");
    expect(await d1.DB.prepare("SELECT kind, ok FROM login_attempts").all().then((r) => r.results)).toEqual([{ kind: "access", ok: 0 }]);
  });

  it("オーナーでない人", async () => {
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign({ email: "someone@example.com" }) } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("forbidden");
  });

  it.each([
    ["期限の切れた証明", { exp: Math.floor(clock.now() / 1000) - 1 }],
    ["ほかのアプリの証明", { aud: ["other-aud"] }],
    ["ほかのチームの証明", { iss: "https://other.cloudflareaccess.com" }],
  ])("%s は 401", async (_, claims) => {
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign(claims) } });
    expect(res.status).toBe(401);
  });

  it("署名を書き換えた証明と、alg を none にした証明は 401", async () => {
    const proof = await gate.access.sign();
    const [head = "", body = ""] = proof.split(".");
    const none = `${btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "")}.${body}.`;
    for (const bad of [`${proof.slice(0, -4)}AAAA`, none, `${head}.${body}.`]) {
      const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": bad } });
      expect(res.status).toBe(401);
    }
  });

  it("証明が正しくてもログインセッションが無ければ 401", async () => {
    const res = await gate.request("/api/v1/me", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("unauthenticated");
  });
});

describe("総当たりと怪しい動き", () => {
  it("同じ送信元の失敗が 10 分に 5 回でロックアウトし、証明が正しくても 403 locked_out", async () => {
    const from = { "CF-Connecting-IP": "203.0.113.9" };
    for (let n = 0; n < 5; n += 1) await gate.request("/api/v1/health", { headers: from });
    const res = await gate.request("/api/v1/sessions", { method: "POST", headers: { ...from, Origin: ORIGIN, "Cf-Access-Jwt-Assertion": await gate.access.sign() } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("locked_out");
  });
});

describe("レート制限", () => {
  it("ログインセッションの開始は 1 分 10 回を超えると 429 と Retry-After", async () => {
    const headers = { Origin: ORIGIN, "Cf-Access-Jwt-Assertion": await gate.access.sign() };
    for (let n = 0; n < 10; n += 1) expect((await gate.request("/api/v1/sessions", { method: "POST", headers })).status).toBe(201);
    const res = await gate.request("/api/v1/sessions", { method: "POST", headers });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("ブラウザーの守り", () => {
  it("GET 以外は Origin が自分と違えば 403 origin_mismatch", async () => {
    const headers = await gate.signIn();
    for (const origin of ["https://evil.example", ""]) {
      const res = await gate.request("/api/v1/sessions", { method: "DELETE", headers: { ...headers, Origin: origin } });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("origin_mismatch");
    }
  });

  it("ログインの順は 401、403、404 の順に確かめる", async () => {
    expect((await gate.request("/api/v1/nothing")).status).toBe(401);
    const headers = await gate.signIn();
    expect((await gate.request("/api/v1/nothing", { headers })).status).toBe(404);
  });
});
