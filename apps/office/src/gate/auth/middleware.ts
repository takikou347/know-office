// ログインの入口のミドルウェア。ロックアウトとレート制限、Access の証明、ログインセッション、Origin の順に確かめる (API の決まりの 1.2)
import { AppError, log, newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { loginAttempts } from "../db/main.ts";
import { endpoints } from "../endpoints.ts";
import type { GateEnv, Guard } from "../env.ts";
import { verifyAccess } from "./access.ts";
import type { RateBucket } from "./guard-book.ts";
import { readSession, SESSION_COOKIE, signingKey } from "./session.ts";
import { vaultKey } from "./vault.ts";

/** ログインセッションの開始とパスキーのパス。1 分 10 回に絞る (API の決まりの 3.6 の 2) */
const AUTH_PATHS = /^\/api\/v1\/(sessions$|me\/step-up$|passkeys(\/options)?$)/;

/**
 * 全体のセキュリティ DO を返す
 * @param c 要求の文脈
 * @returns GuardDO の RPC
 */
export function guardOf(c: Context<GateEnv>): Guard {
  return c.env.GUARD.get(c.env.GUARD.idFromName("guard"));
}

/**
 * ログインの失敗を login_attempts に残し、ロックアウトの数に足す
 * @param c 要求の文脈
 * @param kind access か passkey
 * @param reason 失敗の理由。鍵や証明の中身は入れない
 */
export async function recordLoginFailure(c: Context<GateEnv>, kind: "access" | "passkey", reason: string): Promise<void> {
  const now = c.var.clock.now();
  const country = c.req.header("CF-IPCountry") ?? null;
  await guardOf(c).fail(c.var.ip, now);
  // D1 に書けなくても、断る返事は変えない。数えるのは GuardDO なので、ロックアウトは効く
  await drizzle(c.env.DB)
    .insert(loginAttempts)
    .values({ id: newId(c.var.clock), at: now, ip: c.var.ip, country, kind, ok: false, reason })
    .catch((error: unknown) => log("warn", "login_attempt_not_recorded", { traceId: c.var.traceId, error: String(error) }));
}

/**
 * 送信元がロックアウト中なら 403、1 分の数を超えたら 429 で断る
 * @throws locked_out 送信元がロックアウト中の時
 * @throws rate_limited 1 分の数を超えた時。Retry-After に秒数を入れる
 */
export const admission = createMiddleware<GateEnv>(async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  c.set("ip", ip);
  const bucket: RateBucket = c.req.method === "POST" && AUTH_PATHS.test(c.req.path) ? "auth" : "api";
  const { locked, retryAfter } = await guardOf(c).admit(ip, bucket, c.var.clock.now());
  // ロックアウトは誰か分かる前に確かめるので、誰か分からなくても 403 を返す。API の決まりの 3.2
  if (locked) throw new AppError("locked_out", "失敗が続いたため、この送信元はしばらく使えない");
  if (retryAfter !== null) throw new AppError("rate_limited", "要求が多すぎる", { headers: { "Retry-After": String(retryAfter) } });
  await next();
});

/**
 * Access の証明を確かめ、メールアドレスを置く。失敗はロックアウトの数に足す
 * @throws unauthenticated 証明が無いか合わない時
 * @throws forbidden オーナーでない時
 */
export const accessProof = createMiddleware<GateEnv>(async (c, next) => {
  const config = {
    certsUrl: endpoints(c.env).accessCerts,
    team: c.env.ACCESS_TEAM,
    aud: c.env.ACCESS_AUD,
    ownerEmail: c.env.OWNER_EMAIL,
  };
  try {
    c.set("email", await verifyAccess(c.req.header("Cf-Access-Jwt-Assertion"), config, c.var.fetch, c.var.clock));
  } catch (error) {
    if (error instanceof AppError && (error.code === "unauthenticated" || error.code === "forbidden")) {
      await recordLoginFailure(c, "access", error.message);
    }
    throw error;
  }
  await next();
});

/** ログインセッションを確かめないルート。セッションを作る所と、D1 が止まっても答える稼働確認 */
const WITHOUT_SESSION = new Set(["POST /api/v1/sessions", "GET /api/v1/health"]);

/**
 * ログインセッションのクッキーを確かめ、今のセッションを置く
 * @throws unauthenticated クッキーが無い、合わない、切れている時
 */
export const loginSession = createMiddleware<GateEnv>(async (c, next) => {
  if (WITHOUT_SESSION.has(`${c.req.method} ${c.req.path}`)) {
    c.set("session", undefined);
    await next();
    return;
  }
  const key = await signingKey(await vaultKey(c.env.DB, "session_signing", c.env.MASTER_KEY, c.var.clock));
  c.set("session", await readSession(c.env.DB, key, getCookie(c, SESSION_COOKIE), c.var.clock));
  await next();
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * GET 以外は Origin が自分と同じ時だけ通す。ほかのサイトからの書き換えを断る
 * @throws origin_mismatch Origin が無いか、自分と違う時
 */
export const sameOrigin = createMiddleware<GateEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }
  // Access の後ろでは要求の URL が公開の URL なので、その origin と比べる
  if (c.req.header("Origin") !== new URL(c.req.url).origin) throw new AppError("origin_mismatch", "Origin が異なる");
  await next();
});
