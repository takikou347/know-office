// 認証: ログインセッションの開始、一覧、終了と、ログイン中の人 (ログインと記録の 3.2、ルートの一覧の 1.2)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, jstClock, Me, newId, Session } from "@know-office/core";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { cookieHeader, createSession, IDLE_MS, isActive, signingKey, toSession, type SessionRow } from "../auth/session.ts";
import { vaultKey } from "../auth/vault.ts";
import { notices, passkeys, sessions } from "../db/main.ts";
import type { GateEnv } from "../env.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, noContent, ok } from "../respond.ts";

const router = createRouter();
const DAY = 24 * 60 * 60_000;
/** 新しい国かを比べる前のログインセッションの期間 (90 日)。ログインと記録の 3.2 */
const COUNTRY_WINDOW_MS = 90 * DAY;

const createSessionRoute = createRoute({
  method: "post",
  path: "/api/v1/sessions",
  operationId: "createSession",
  tags: ["auth"],
  responses: { 201: okResponse(Session, "作成した"), ...problems(401, 403, 429, 500) },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/api/v1/sessions",
  operationId: "listSessions",
  tags: ["auth"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(Session), ...problems(401, 403, 429, 500) },
});

const deleteOtherSessionsRoute = createRoute({
  method: "delete",
  path: "/api/v1/sessions",
  operationId: "deleteOtherSessions",
  tags: ["auth"],
  responses: { 204: { description: "終了した" }, ...problems(401, 403, 429, 500) },
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/api/v1/sessions/{sessionId}",
  operationId: "deleteSession",
  tags: ["auth"],
  request: { params: z.object({ sessionId: z.uuid().openapi({ param: { name: "sessionId", in: "path" } }) }).strict() },
  responses: { 204: { description: "終了した" }, ...problems(401, 403, 404, 429, 500) },
});

const getMeRoute = createRoute({
  method: "get",
  path: "/api/v1/me",
  operationId: "getMe",
  tags: ["auth"],
  responses: { 200: okResponse(Me), ...problems(401, 403, 429, 500) },
});

/**
 * 今の要求のログインセッションを返す。ミドルウェアが置いた物
 * @param c 要求の文脈
 * @returns 今のログインセッション
 * @throws unauthenticated ログインセッションが無い時 (ミドルウェアを通っていれば起きない)
 */
export function currentSession(c: Context<GateEnv>): SessionRow {
  const session = c.var.session;
  if (!session) throw new AppError("unauthenticated", "ログインセッションが無い");
  return session;
}

/**
 * セッションの署名の鍵を読む
 * @param c 要求の文脈
 * @returns HMAC の鍵
 */
export async function sessionKey(c: Context<GateEnv>): Promise<CryptoKey> {
  return signingKey(await vaultKey(c.env.DB, "session_signing", c.env.MASTER_KEY, c.var.clock));
}

/**
 * 新しい国か深夜のログインなら、オーナーに通知を出す。ログインと記録の 3.2
 * @param c 要求の文脈
 * @param row 作ったログインセッション
 */
async function noticeUnusualLogin(c: Context<GateEnv>, row: SessionRow): Promise<void> {
  const orm = drizzle(c.env.DB);
  const since = row.createdAt - COUNTRY_WINDOW_MS;
  // 前の 90 日のログインの国を集める。初めてのログインは比べる物が無いので、新しい国として扱わない
  const countries = await orm
    .selectDistinct({ country: sessions.country })
    .from(sessions)
    .where(and(gt(sessions.createdAt, since), ne(sessions.id, row.id)));
  const newCountry = countries.length > 0 && !countries.some((seen) => seen.country === row.country);
  const hour = Number(jstClock(row.createdAt).slice(0, 2));
  const reasons = [...(newCountry ? [`新しい国 (${row.country ?? "不明"}) からのログイン`] : []), ...(hour < 6 ? ["日本時間の 0 時から 6 時のログイン"] : [])];
  if (reasons.length === 0) return;
  // 自動停止 (tasks.md の 6 章) ができたら、同じ時に guard.observe へ login を渡す
  await orm.insert(notices).values({
    id: newId(c.var.clock),
    at: row.createdAt,
    level: "warn",
    kind: "unusual_login",
    title: "いつもと違うログインがあった",
    body: `${reasons.join("、")}。送信元 ${row.ip}`,
    scope: "office",
  });
}

/** 認証のルート: ログインセッションとログイン中の人 */
export const sessionRoutes = router
  .openapi(createSessionRoute, async (c) => {
    const from = {
      ip: c.var.ip,
      country: c.req.header("CF-IPCountry") ?? "XX",
      // 長いヘッダーで D1 を太らせない
      userAgent: (c.req.header("User-Agent") ?? "").slice(0, 512),
    };
    const { row, cookie } = await createSession(c.env.DB, await sessionKey(c), from, c.var.clock);
    await noticeUnusualLogin(c, row);
    await audit(c, "session.create", row.id, { ip: row.ip, country: row.country });
    c.header("Set-Cookie", cookieHeader(cookie, Math.floor((row.expiresAt - row.createdAt) / 1000)));
    return created(c, toSession(row, row.id), `/api/v1/sessions/${row.id}`);
  })
  .openapi(listSessionsRoute, async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const now = c.var.clock.now();
    // ID は UUID v7 で作った順に並ぶので、カーソルは前のページの最後の ID
    const rows = await drizzle(c.env.DB)
      .select()
      .from(sessions)
      .where(and(isNull(sessions.endedAt), gt(sessions.expiresAt, now), gt(sessions.lastSeenAt, now - IDLE_MS), cursor ? gt(sessions.id, cursor) : undefined))
      .orderBy(asc(sessions.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
    return list(c, page.map((row) => toSession(row, currentSession(c).id)), next);
  })
  .openapi(deleteOtherSessionsRoute, async (c) => {
    const current = currentSession(c);
    await drizzle(c.env.DB)
      .update(sessions)
      .set({ endedAt: c.var.clock.now() })
      .where(and(isNull(sessions.endedAt), ne(sessions.id, current.id)));
    await audit(c, "session.end_others", current.id);
    return noContent(c);
  })
  .openapi(deleteSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const orm = drizzle(c.env.DB);
    const [row] = await orm.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row || !isActive(row, c.var.clock.now())) throw new AppError("not_found", "ログインセッションが無いか、もう終わっている");
    await orm.update(sessions).set({ endedAt: c.var.clock.now() }).where(eq(sessions.id, sessionId));
    // 今のセッションを切った時は、ブラウザーにもクッキーを消させる
    if (row.id === currentSession(c).id) c.header("Set-Cookie", cookieHeader("", 0));
    await audit(c, "session.end", row.id);
    return noContent(c);
  })
  .openapi(getMeRoute, async (c) => {
    const session = currentSession(c);
    const [passkey] = await drizzle(c.env.DB).select({ id: passkeys.id }).from(passkeys).limit(1);
    return ok(c, {
      email: c.var.email,
      sessionId: session.id,
      stepUpUntil: session.stepUpUntil === null ? null : new Date(session.stepUpUntil).toISOString(),
      hasPasskey: passkey !== undefined,
    });
  });
