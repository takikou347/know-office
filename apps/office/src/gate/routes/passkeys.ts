// 認証: パスキーの登録と、パスキーでの確認 (ログインと記録の 3.3、ルートの一覧の 1.2)
import { createRoute } from "@hono/zod-openapi";
import { AppError, newId, Passkey, PasskeyOptions, PasskeyOptionsInput, StepUp, WebAuthnResponse } from "@know-office/core";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { guardOf, recordLoginFailure } from "../auth/middleware.ts";
import { AuthenticationResponse, RegistrationResponse, relyingParty, requireStepUp, Transports } from "../auth/passkey.ts";
import { cookieHeader, issueSession, STEP_UP_MS } from "../auth/session.ts";
import { loginAttempts, passkeys, sessions } from "../db/main.ts";
import type { GateEnv } from "../env.ts";
import { audit } from "../ledger/record.ts";
import { okResponse, problems } from "../openapi.ts";
import { created, ok } from "../respond.ts";
import { currentSession, sessionKey } from "./sessions.ts";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });

const createPasskeyOptionsRoute = createRoute({
  method: "post",
  path: "/api/v1/passkeys/options",
  operationId: "createPasskeyOptions",
  tags: ["auth"],
  request: { body: jsonBody(PasskeyOptionsInput) },
  responses: { 200: okResponse(PasskeyOptions), ...problems(400, 401, 403, 413, 415, 422, 429, 500) },
});

const registerPasskeyRoute = createRoute({
  method: "post",
  path: "/api/v1/passkeys",
  operationId: "registerPasskey",
  tags: ["auth"],
  "x-step-up": "conditional",
  request: { body: jsonBody(WebAuthnResponse) },
  responses: { 201: okResponse(Passkey, "作成した"), ...problems(400, 401, 403, 413, 415, 422, 429, 500) },
});

const stepUpRoute = createRoute({
  method: "post",
  path: "/api/v1/me/step-up",
  operationId: "stepUp",
  tags: ["auth"],
  request: { body: jsonBody(WebAuthnResponse) },
  responses: { 200: okResponse(StepUp), ...problems(400, 401, 403, 413, 415, 422, 429, 500) },
});

/**
 * パスキーの確認に失敗した時に、失敗の数に足して 401 を投げる
 * @param c 要求の文脈
 * @param reason 理由
 * @returns 返らない
 * @throws unauthenticated いつも
 */
async function rejectPasskey(c: Context<GateEnv>, reason: string): Promise<never> {
  await recordLoginFailure(c, "passkey", reason);
  throw new AppError("unauthenticated", "パスキーの確認が合わない");
}

/**
 * 今のセッションに結んだ challenge を取り出す。目的が違えば失敗として数える
 * @param c 要求の文脈
 * @param purpose 登録か確認か
 * @returns challenge
 * @throws unauthenticated challenge が無い、切れた、目的が違う時
 */
async function takeChallenge(c: Context<GateEnv>, purpose: "register" | "step_up"): Promise<string> {
  const stored = await guardOf(c).takeChallenge(currentSession(c).id, c.var.clock.now());
  if (stored?.purpose !== purpose) return rejectPasskey(c, "challenge が無いか目的が違う");
  return stored.challenge;
}

/** 認証のルート: パスキーの登録と確認 */
export const passkeyRoutes = createRouter()
  .openapi(createPasskeyOptionsRoute, async (c) => {
    const { purpose } = c.req.valid("json");
    const { rpID } = relyingParty(c);
    const stored = await drizzle(c.env.DB).select({ credentialId: passkeys.credentialId, transports: passkeys.transports }).from(passkeys);
    const known = stored.map((p) => ({ id: p.credentialId, transports: Transports.catch([]).parse(p.transports) }));
    const options =
      purpose === "register"
        ? await generateRegistrationOptions({
            rpName: "know-office",
            rpID,
            userName: c.var.email,
            attestationType: "none",
            // 同じ認証器を 2 度登録させない
            excludeCredentials: known,
            authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          })
        : await generateAuthenticationOptions({ rpID, allowCredentials: known, userVerification: "required" });
    // challenge は今のログインセッションに結ぶので、ほかの端末のセッションでは使えない
    await guardOf(c).putChallenge(currentSession(c).id, { challenge: options.challenge, purpose }, c.var.clock.now());
    return ok(c, { ...options });
  })
  .openapi(registerPasskeyRoute, async (c) => {
    const orm = drizzle(c.env.DB);
    const [existing] = await orm.select({ id: passkeys.id }).from(passkeys).limit(1);
    // 最初の 1 本はパスキーが無いので確かめようがない。2 本目からは盗んだセッションで鍵を足させない
    if (existing) requireStepUp(c);
    // API の形は WebAuthn の返事そのもの (additionalProperties: true) なので、確かめる前に登録の返事の形に絞る
    const response = RegistrationResponse.safeParse(c.req.valid("json"));
    if (!response.success) throw new AppError("validation_failed", "登録の返事の形が違う");
    const expectedChallenge = await takeChallenge(c, "register");
    const { rpID, origin } = relyingParty(c);
    const result = await verifyRegistrationResponse({ response: response.data, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }).catch(
      () => null,
    );
    const credential = result?.verified ? result.registrationInfo?.credential : undefined;
    if (!credential) return rejectPasskey(c, "登録の返事が合わない");
    const [same] = await orm.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credential.id)).limit(1);
    if (same) throw new AppError("conflict", "同じパスキーがもう登録されている");
    const row = {
      id: newId(c.var.clock),
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      createdAt: c.var.clock.now(),
      lastUsedAt: null,
    };
    await orm.insert(passkeys).values(row);
    await audit(c, "passkey.add", row.id);
    return created(c, { id: row.id, createdAt: new Date(row.createdAt).toISOString() }, `/api/v1/passkeys/${row.id}`);
  })
  .openapi(stepUpRoute, async (c) => {
    const response = AuthenticationResponse.safeParse(c.req.valid("json"));
    if (!response.success) throw new AppError("validation_failed", "確認の返事の形が違う");
    const expectedChallenge = await takeChallenge(c, "step_up");
    const orm = drizzle(c.env.DB);
    const [passkey] = await orm.select().from(passkeys).where(eq(passkeys.credentialId, response.data.id)).limit(1);
    if (!passkey) return rejectPasskey(c, "登録の無いパスキー");
    const { rpID, origin } = relyingParty(c);
    const result = await verifyAuthenticationResponse({
      response: response.data,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: passkey.credentialId, publicKey: isoBase64URL.toBuffer(passkey.publicKey), counter: passkey.counter, transports: Transports.catch([]).parse(passkey.transports) },
      requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified) return rejectPasskey(c, "確認の返事が合わない");

    const now = c.var.clock.now();
    const before = currentSession(c);
    // 確認の前に盗まれたクッキーで確認の後の操作をさせないよう、セッションを作り直す。期限は元のセッションの物を引き継ぐ
    const from = { ip: c.var.ip, country: before.country ?? "XX", userAgent: before.userAgent ?? "" };
    const { row, cookie } = await issueSession(await sessionKey(c), from, c.var.clock, { expiresAt: before.expiresAt, stepUpUntil: now + STEP_UP_MS });
    // 新しいセッション、カウンター、前のセッションの終わり、ログインの記録は、どれかが落ちたら全て入れない
    await orm.batch([
      orm.insert(sessions).values(row),
      orm.update(passkeys).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: now }).where(eq(passkeys.id, passkey.id)),
      orm.update(sessions).set({ endedAt: now }).where(eq(sessions.id, before.id)),
      orm.insert(loginAttempts).values({ id: newId(c.var.clock), at: now, ip: c.var.ip, country: before.country, kind: "passkey", ok: true, reason: null }),
    ]);
    await audit(c, "session.step_up", row.id, { from: before.id });
    c.header("Set-Cookie", cookieHeader(cookie, Math.floor((row.expiresAt - now) / 1000)));
    return ok(c, { stepUpUntil: new Date(now + STEP_UP_MS).toISOString() });
  });
