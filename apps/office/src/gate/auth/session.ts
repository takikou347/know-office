// ログインセッション。クッキーにはトークンと署名、D1 にはトークンのハッシュだけを置く (ログインと記録の 3.2)
import { AppError, type Clock, newId, type Session, sha256Hex } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import { sessions } from "../db/main.ts";

/** D1 の sessions の 1 行 */
export type SessionRow = typeof sessions.$inferSelect;

/** クッキーの名前。__Host- でほかのサブドメインから同じ名前を置けなくする */
export const SESSION_COOKIE = "__Host-ko_session";
/** ログインセッションの長さ (12 時間) */
export const SESSION_MS = 12 * 60 * 60_000;
/** 操作が無いと切れるまでの時間 (2 時間) */
export const IDLE_MS = 2 * 60 * 60_000;
/** last_seen_at を書き直す間 (5 分)。要求ごとに D1 へ書かない */
const TOUCH_MS = 5 * 60_000;
/** パスキーの確認が効く時間 (15 分) */
export const STEP_UP_MS = 15 * 60_000;

const encoder = new TextEncoder();
const b64url = (data: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(data))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));

/**
 * セッションの署名の鍵を HMAC-SHA256 の鍵にする
 * @param secret vault の session_signing
 * @returns 署名と確かめに使う鍵
 */
export function signingKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * Set-Cookie の値を作る
 * @param value トークンと署名。消す時は空
 * @param maxAgeSeconds 残りの秒数。消す時は 0
 * @returns Set-Cookie の値
 */
export function cookieHeader(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${String(maxAgeSeconds)}`;
}

/**
 * ログインセッションを作り、クッキーの値を返す
 * @param db 今の状態の D1
 * @param key 署名の鍵
 * @param from 送信元の IP、国、ブラウザー
 * @param clock 時刻
 * @param carry パスキーの確認で作り直す時に引き継ぐ期限と、確認の期限
 * @returns 作った行とクッキーの値
 */
export async function createSession(
  db: D1Database,
  key: CryptoKey,
  from: { ip: string; country: string; userAgent: string },
  clock: Clock,
  carry: { expiresAt: number; stepUpUntil: number } | null = null,
): Promise<{ row: SessionRow; cookie: string }> {
  const now = clock.now();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const row: SessionRow = {
    id: newId(clock),
    // D1 の中身が漏れてもクッキーを作れないよう、トークンそのものは置かない
    tokenHash: await sha256Hex(token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: carry?.expiresAt ?? now + SESSION_MS,
    endedAt: null,
    stepUpUntil: carry?.stepUpUntil ?? null,
    ip: from.ip,
    country: from.country,
    userAgent: from.userAgent,
  };
  await drizzle(db).insert(sessions).values(row);
  const signature = b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(token)));
  return { row, cookie: `${token}.${signature}` };
}

/**
 * クッキーの値からログインセッションを読む。切れていないかを確かめ、5 分ごとに last_seen_at を書き直す
 * @param db 今の状態の D1
 * @param key 署名の鍵
 * @param cookie クッキーの値
 * @param clock 時刻
 * @returns 今のログインセッション
 * @throws unauthenticated クッキーが無い、署名が合わない、切れた、切られた、無い時
 */
export async function readSession(db: D1Database, key: CryptoKey, cookie: string | undefined, clock: Clock): Promise<SessionRow> {
  const [token, signature] = (cookie ?? "").split(".");
  if (!token || !signature) throw new AppError("unauthenticated", "ログインセッションが無い");
  // HMAC の verify は時間が一定の比べ方をする。API の決まりの 3.6 の 3
  const valid = await crypto.subtle.verify("HMAC", key, fromB64url(signature), encoder.encode(token)).catch(() => false);
  if (!valid) throw new AppError("unauthenticated", "ログインセッションの署名が合わない");
  const orm = drizzle(db);
  const [row] = await orm
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, await sha256Hex(token)))
    .limit(1);
  const now = clock.now();
  if (!row || row.endedAt !== null || row.expiresAt <= now || row.lastSeenAt + IDLE_MS <= now) {
    throw new AppError("unauthenticated", "ログインセッションが切れている");
  }
  if (now - row.lastSeenAt >= TOUCH_MS) {
    await orm.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id));
    return { ...row, lastSeenAt: now };
  }
  return row;
}

/**
 * 行が今も使えるかを返す。一覧で切れた物を外すのに使う
 * @param row セッションの行
 * @param now 今の時刻
 * @returns 切られておらず、期限と操作の無い時間の内なら true
 */
export function isActive(row: SessionRow, now: number): boolean {
  return row.endedAt === null && row.expiresAt > now && row.lastSeenAt + IDLE_MS > now;
}

/**
 * 行を API の返す形にする
 * @param row セッションの行
 * @param currentId 今の要求のセッションの ID
 * @returns Session
 */
export function toSession(row: SessionRow, currentId: string): Session {
  return {
    id: row.id,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString(),
    current: row.id === currentId,
    ip: row.ip,
    country: row.country ?? "",
    userAgent: row.userAgent ?? "",
  };
}
