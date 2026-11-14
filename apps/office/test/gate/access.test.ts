// 入れるのはオーナーだけ。Access の証明、ロックアウト、レート制限、Origin を確かめる (ログインと記録の 3.1、API の決まりの 1.2、3.2)
import { Problem, toBase64url } from "@know-office/core";
import { createFakeAccess } from "../../dev/access.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, ORIGIN, OWNER, type TestGate } from "../helpers/gate.ts";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
// テストごとに時刻、空の D1、ゲートウェイを作り、前のテストの失敗の数や進めた時刻に頼らない
beforeEach(async () => {
  clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
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

/**
 * JWT のヘッダーを base64url の JSON にする
 * @param value ヘッダー
 * @returns JWT の 1 つの部分
 */
function jsonPart(value: unknown): string {
  return toBase64url(new TextEncoder().encode(JSON.stringify(value)));
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
    ["期限の切れた証明", () => ({ exp: Math.floor(clock.now() / 1000) - 1 })],
    ["ほかのアプリの証明", () => ({ aud: ["other-aud"] })],
    ["ほかのチームの証明", () => ({ iss: "https://other.cloudflareaccess.com" })],
  ])("%s は 401", async (_, claims) => {
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign(claims()) } });
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

  it("ほかの鍵で署名した証明と、alg を HS256 にすり替えた証明は 401", async () => {
    const stranger = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock });
    const [, body = ""] = (await gate.access.sign()).split(".");
    const input = `${jsonPart({ alg: "HS256", kid: gate.access.kid(), typ: "JWT" })}.${body}`;
    const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode("guessed"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hs256 = `${input}.${toBase64url(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(input)))}`;
    for (const bad of [await stranger.sign(), hs256]) {
      const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": bad } });
      expect(res.status).toBe(401);
    }
  });

  it("メールアドレスは大文字と小文字を区別しない", async () => {
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign({ email: OWNER.toUpperCase() }) } });
    expect(res.status).toBe(200);
  });

  it("公開鍵は 1 時間ためて、その間は取りに行かない", async () => {
    const health = async () => gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } });
    expect((await health()).status).toBe(200);
    clock.advance(59 * 60_000);
    expect((await health()).status).toBe(200);
    expect(gate.certs.calls).toBe(1);
    clock.advance(2 * 60_000);
    expect((await health()).status).toBe(200);
    expect(gate.certs.calls).toBe(2);
  });

  it("Access が鍵を取り替えた後の証明は、公開鍵を 1 度だけ取り直して通す", async () => {
    expect((await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } })).status).toBe(200);
    clock.advance(31_000);
    await gate.access.rotate();
    expect((await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } })).status).toBe(200);
    expect(gate.certs.calls).toBe(2);
  });

  it("知らない kid の証明では、30 秒に 1 度しか公開鍵を取り直さない", async () => {
    const stranger = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock });
    const proof = await stranger.sign();
    for (let n = 0; n < 3; n += 1) expect((await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": proof } })).status).toBe(401);
    expect(gate.certs.calls).toBe(1);
    clock.advance(31_000);
    expect((await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await stranger.sign() } })).status).toBe(401);
    expect(gate.certs.calls).toBe(2);
  });

  it("公開鍵を読めない時は証明を通さず 503 unavailable にし、失敗の数に足さず、30 秒は取りに行かない", async () => {
    gate.certs.answer = "down";
    const proof = await gate.access.sign();
    for (let n = 0; n < 3; n += 1) {
      const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": proof } });
      expect(res.status).toBe(503);
      expect(await codeOf(res)).toBe("unavailable");
    }
    expect(gate.certs.calls).toBe(1);
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM login_attempts").first("n")).toBe(0);
    gate.certs.answer = "ok";
    clock.advance(31_000);
    expect((await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } })).status).toBe(200);
  });

  it("公開鍵を取り直せなくても、ためた鍵で知っている kid の証明は通し、知らない kid は 30 秒取りに行かず 503", async () => {
    const health = async (proof: string) => gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": proof } });
    expect((await health(await gate.access.sign())).status).toBe(200);
    clock.advance(61 * 60_000);
    gate.certs.answer = "down";
    // 1 時間を過ぎて取り直しに失敗しても、ためた鍵で確かめる
    for (let n = 0; n < 3; n += 1) expect((await health(await gate.access.sign())).status).toBe(200);
    expect(gate.certs.calls).toBe(2);
    // 知らない kid は断る側に倒し、失敗の後 30 秒は取りに行かない
    const stranger = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock });
    const res = await health(await stranger.sign());
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe("unavailable");
    expect(gate.certs.calls).toBe(2);
    // 30 秒を過ぎたら取り直し、戻った Access の鍵をためる
    clock.advance(31_000);
    gate.certs.answer = "ok";
    expect((await health(await gate.access.sign())).status).toBe(200);
    expect(gate.certs.calls).toBe(3);
  });

  it("知らない kid の取り直しに失敗した後も、知っている kid の証明は通す", async () => {
    const health = async (proof: string) => gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": proof } });
    expect((await health(await gate.access.sign())).status).toBe(200);
    clock.advance(61 * 60_000);
    gate.certs.answer = "down";
    const stranger = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock });
    expect((await health(await stranger.sign())).status).toBe(503);
    expect((await health(await gate.access.sign())).status).toBe(200);
    expect(gate.certs.calls).toBe(2);
  });

  it("最後に取れてから 24 時間を過ぎた鍵では、知っている kid の証明も通さず 503 unavailable", async () => {
    const health = async () => gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } });
    expect((await health()).status).toBe(200);
    clock.advance(23 * 60 * 60_000);
    gate.certs.answer = "down";
    expect((await health()).status).toBe(200);
    clock.advance(61 * 60_000);
    const res = await health();
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe("unavailable");
    expect(gate.certs.calls).toBe(3);
  });

  it("公開鍵の形が違えば証明を通さず 503 unavailable", async () => {
    gate.certs.answer = "malformed";
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } });
    expect(res.status).toBe(503);
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

  it("ログインセッションの開始は 1 分 10 回を超えると 429 と Retry-After", async () => {
    const headers = { Origin: ORIGIN, "Cf-Access-Jwt-Assertion": await gate.access.sign() };
    for (let n = 0; n < 10; n += 1) expect((await gate.request("/api/v1/sessions", { method: "POST", headers })).status).toBe(201);
    const res = await gate.request("/api/v1/sessions", { method: "POST", headers });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("画面と入力のセキュリティ", () => {
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
    const stranger = { "Cf-Access-Jwt-Assertion": await gate.access.sign({ email: "someone@example.com" }) };
    expect((await gate.request("/api/v1/nothing", { headers: stranger })).status).toBe(403);
    const headers = await gate.signIn();
    expect((await gate.request("/api/v1/nothing", { headers })).status).toBe(404);
  });
});
