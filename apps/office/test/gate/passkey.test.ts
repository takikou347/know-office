// パスキーの登録と、大事な操作の前の確認 (ログインと記録の 3.3、ルートの一覧の 1.2)
import { Passkey, PasskeyOptions, Problem, StepUp } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAuthenticator, type Authenticator } from "../helpers/authenticator.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, ORIGIN, type TestGate } from "../helpers/gate.ts";

const MINUTE = 60_000;
let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
let authenticator: Authenticator;
// テストごとに空の D1 とゲートウェイを作り、ログインしてから始める
beforeEach(async () => {
  clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
  authenticator = await createAuthenticator();
});
afterEach(() => d1.dispose());

/**
 * JSON の本文を送る
 * @param path パス
 * @param body 本文
 * @returns 返事
 */
function post(path: string, body: unknown): Promise<Response> {
  return gate.request(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// 認証器が読む所だけを確かめる。登録のオプションは確認のオプションの形も満たす
const Options = z.object({ challenge: z.string(), rpId: z.string().optional(), rp: z.object({ id: z.string().optional() }).optional(), user: z.object({ id: z.string() }).optional() });

/**
 * WebAuthn のオプションをもらう
 * @param purpose 登録か確認か
 * @returns ブラウザーに渡すオプション
 */
async function options(purpose: "register" | "step_up") {
  const res = await post("/api/v1/passkeys/options", { purpose });
  expect(res.status).toBe(200);
  return Options.parse(z.object({ data: PasskeyOptions }).parse(await res.json()).data);
}

/**
 * 登録のオプションをもらう
 * @returns 認証器に渡す登録のオプション
 */
async function registrationOptions() {
  const { challenge, rp, user } = await options("register");
  if (!rp || !user) throw new Error("登録のオプションでない");
  return { challenge, rp, user };
}

/**
 * ソフトウェアの認証器でパスキーを登録する
 * @param device 登録する認証器
 * @returns 返事
 */
async function register(device: Authenticator = authenticator): Promise<Response> {
  // 認証器はゲートウェイが返した JSON をそのまま受ける。形は @simplewebauthn/server が作った物
  const response = await device.register(await registrationOptions(), ORIGIN);
  return post("/api/v1/passkeys", response);
}

/**
 * パスキーで確認し、新しいクッキーに差し替える
 * @returns 返事
 */
async function stepUp(): Promise<Response> {
  const response = await authenticator.authenticate(await options("step_up"), ORIGIN);
  const res = await post("/api/v1/me/step-up", response);
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
  if (res.status === 200 && cookie) headers = { ...headers, Cookie: cookie };
  return res;
}

/**
 * 失敗の code を読む
 * @param res 返事
 * @returns problem+json の code
 */
async function codeOf(res: Response): Promise<string> {
  return Problem.parse(await res.json()).code;
}

describe("大事な操作の前にパスキーで確かめる", () => {
  it("最初の 1 本は確認無しで登録できる", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const { data } = z.object({ data: Passkey }).parse(await res.json());
    expect(res.headers.get("Location")).toBe(`/api/v1/passkeys/${data.id}`);
    expect(await gate.request("/api/v1/me", { headers }).then((r) => r.json())).toMatchObject({ data: { hasPasskey: true } });
    expect(gate.audits.map((a) => a.action)).toEqual(["session.create", "passkey.add"]);
    const { results } = await d1.DB.prepare("SELECT counter FROM passkeys").all();
    expect(results).toEqual([{ counter: 0 }]);
  });

  it("確認が切れている", async () => {
    await register();
    const second = await createAuthenticator();
    // 2 本目からは 15 分のうちの確認が要る
    const without = await register(second);
    expect(without.status).toBe(401);
    expect(await codeOf(without)).toBe("step_up_required");
    const res = await stepUp();
    expect(res.status).toBe(200);
    const { data } = z.object({ data: StepUp }).parse(await res.json());
    expect(data.stepUpUntil).toBe(new Date(clock.now() + 15 * MINUTE).toISOString());
    expect((await register(second)).status).toBe(201);
    // 前の確認から 15 分を過ぎると、また確認が求められる
    clock.advance(15 * MINUTE + 1);
    headers = { ...headers, "Cf-Access-Jwt-Assertion": await gate.access.sign() };
    const third = await register(await createAuthenticator());
    expect(await codeOf(third)).toBe("step_up_required");
  });

  it("同じ鍵をもう一度登録すると 409", async () => {
    await register();
    await stepUp();
    const res = await register();
    expect(res.status).toBe(409);
  });
});

describe("セッションの守り", () => {
  it("確認の後に前のクッキーが 401", async () => {
    await register();
    const before = headers;
    await stepUp();
    expect((await gate.request("/api/v1/me", { headers: before })).status).toBe(401);
    const me: unknown = await gate.request("/api/v1/me", { headers }).then((r) => r.json());
    expect(me).toMatchObject({ data: { stepUpUntil: new Date(clock.now() + 15 * MINUTE).toISOString() } });
    expect(gate.audits.map((a) => a.action)).toEqual(["session.create", "passkey.add", "session.step_up"]);
  });
});

describe("総当たりと怪しい動き", () => {
  it("challenge は 1 度だけ使え、合わない確認は 401 で失敗の数に足す", async () => {
    await register();
    const response = await authenticator.authenticate(await options("step_up"), ORIGIN);
    const first = await post("/api/v1/me/step-up", response);
    expect(first.status).toBe(200);
    // 新しいクッキーで、同じ返事をもう一度送る
    headers = { ...headers, Cookie: (first.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "" };
    const replay = await post("/api/v1/me/step-up", response);
    expect(replay.status).toBe(401);
    expect(await codeOf(replay)).toBe("unauthenticated");
    const { results } = await d1.DB.prepare("SELECT kind, ok FROM login_attempts ORDER BY rowid").all();
    expect(results).toEqual([
      { kind: "passkey", ok: 1 },
      { kind: "passkey", ok: 0 },
    ]);
  });

  it("登録の challenge で確認はできない", async () => {
    await register();
    const response = await authenticator.authenticate(await options("register"), ORIGIN);
    expect((await post("/api/v1/me/step-up", response)).status).toBe(401);
  });
});
