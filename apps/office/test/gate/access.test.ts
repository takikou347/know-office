// 入れるのはオーナーだけ。Access の証明、ロックアウト、レート制限、Origin を確かめる (ログインと記録の 3.1、API の決まりの 4.2、4.3)
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

  it("期限の切れた証明、ほかのアプリやチームの証明、署名を書き換えた証明、alg を none か HS256 にすり替えた証明、ほかの鍵で署名した証明は 401", async () => {
    const proof = await gate.access.sign();
    const [head = "", body = ""] = proof.split(".");
    const none = `${btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "")}.${body}.`;
    const stranger = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock });
    const input = `${jsonPart({ alg: "HS256", kid: gate.access.kid(), typ: "JWT" })}.${body}`;
    const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode("guessed"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hs256 = `${input}.${toBase64url(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(input)))}`;
    const bad = {
      期限の切れた証明: await gate.access.sign({ exp: Math.floor(clock.now() / 1000) - 1 }),
      ほかのアプリの証明: await gate.access.sign({ aud: ["other-aud"] }),
      ほかのチームの証明: await gate.access.sign({ iss: "https://other.cloudflareaccess.com" }),
      署名を書き換えた証明: `${proof.slice(0, -4)}AAAA`,
      "alg を none にした証明": none,
      署名の無い証明: `${head}.${body}.`,
      ほかの鍵で署名した証明: await stranger.sign(),
      "alg を HS256 にすり替えた証明": hs256,
    };
    // 同じ送信元の失敗は 5 回でロックアウトになるので、証明ごとに送信元を変える
    const statuses: Record<string, number> = {};
    for (const [i, [name, assertion]] of Object.entries(bad).entries()) {
      statuses[name] = (await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": assertion, "CF-Connecting-IP": `198.51.100.${String(i + 1)}` } })).status;
    }
    expect(statuses).toEqual(Object.fromEntries(Object.keys(bad).map((name) => [name, 401])));
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

  it("公開鍵を取り直せなくても、ためた鍵で知っている kid の証明は通し、知らない kid は 30 秒取りに行かず 503 で、その後も知っている kid の証明は通す", async () => {
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
    // 知らない kid の取り直しに失敗した後も、知っている kid の証明は通す
    expect((await health(await gate.access.sign())).status).toBe(200);
    expect(gate.certs.calls).toBe(2);
    // 30 秒を過ぎたら取り直し、戻った Access の鍵をためる
    clock.advance(31_000);
    gate.certs.answer = "ok";
    expect((await health(await gate.access.sign())).status).toBe(200);
    expect(gate.certs.calls).toBe(3);
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

// デプロイの後の確かめ (scripts/smoke.ts) は Access の作業用の鍵で聞く。Access はその証明に email を入れず、common_name に Client ID を入れる
const SMOKE_CLIENT_ID = "smoke-client.access";

/**
 * 作業用の鍵で通った時の証明を出す
 * @param commonName 証明の common_name
 * @returns email の無い証明
 */
function serviceProof(commonName: string): Promise<string> {
  return gate.access.sign({ email: undefined, sub: "", common_name: commonName });
}

describe("Access の作業用の鍵", () => {
  beforeEach(() => {
    gate.env.ACCESS_SMOKE_CLIENT_ID = SMOKE_CLIENT_ID;
  });

  it("決めた鍵の証明は稼働確認だけを通す", async () => {
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await serviceProof(SMOKE_CLIENT_ID) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, part: "gate" } });
  });

  it("決めた鍵の証明でもログインセッションは作れない", async () => {
    const res = await gate.request("/api/v1/sessions", { method: "POST", headers: { Origin: ORIGIN, "Cf-Access-Jwt-Assertion": await serviceProof(SMOKE_CLIENT_ID) } });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("unauthenticated");
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("決めた鍵の証明でもセッションの要るほかのルート、稼働確認への GET 以外、末尾に / の付いた稼働確認は Access で断る", async () => {
    const cases = [
      ["/api/v1/me", "GET"],
      ["/api/v1/health", "POST"],
      ["/api/v1/health/", "GET"],
    ] as const;
    // 断ったのが Access の証明の確かめだと分かるよう、Access の失敗の記録が 1 行ずつ増える事も見る。セッションの確かめで断られたのでは、鍵の証明を通した事になる
    const answers: Record<string, string> = {};
    for (const [path, method] of cases) {
      const res = await gate.request(path, { method, headers: { Origin: ORIGIN, "Cf-Access-Jwt-Assertion": await serviceProof(SMOKE_CLIENT_ID) } });
      const failures = await d1.DB.prepare("SELECT count(*) AS n FROM login_attempts WHERE kind = 'access' AND ok = 0").first("n");
      answers[`${method} ${path}`] = `${[401, 405].includes(res.status) ? "断った" : String(res.status)} ${String(failures)}`;
    }
    expect(answers).toEqual({ "GET /api/v1/me": "断った 1", "POST /api/v1/health": "断った 2", "GET /api/v1/health/": "断った 3" });
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM login_attempts").first("n")).toBe(3);
  });

  it("ほかの鍵の証明と、鍵を決めていない時は、稼働確認でも 401", async () => {
    const other = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await serviceProof("other-client.access") } });
    expect(other.status).toBe(401);
    expect(await codeOf(other)).toBe("unauthenticated");
    const env = { ...gate.env, ACCESS_SMOKE_CLIENT_ID: undefined };
    const unset = await gate.app.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await serviceProof(""), "CF-Connecting-IP": "198.51.100.200" } }, env);
    expect(unset.status).toBe(401);
  });

  it("鍵の証明に email も付いていればオーナーとして確かめる", async () => {
    const res = await gate.request("/api/v1/health", {
      headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign({ email: "someone@example.com", common_name: SMOKE_CLIENT_ID }) },
    });
    expect(res.status).toBe(403);
  });
});
