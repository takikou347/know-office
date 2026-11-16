// 画面に出す通知を読み、既読にし、続く Claude の失敗を通知にする (サービスと拡張の 3.5)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type Clock, newId, type Notice } from "@know-office/core";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { notices } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { recordsOf } from "../work/nodes.ts";
import { announceNotice } from "../live/publish.ts";
import { CLAUDE_FAILED } from "./errors.ts";

/** Claude の API の失敗を数える窓と、通知を出す回数。サービスと拡張の 3.5 */
export const CLAUDE_FAILURE_WINDOW_MS = 5 * 60_000;
export const CLAUDE_FAILURE_LIMIT = 3;

/**
 * 行を返す形に直す
 * @param row notices の行
 * @returns 通知
 */
export function toNotice(row: typeof notices.$inferSelect): Notice {
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    level: row.level,
    kind: row.kind,
    title: row.title,
    body: row.body ?? "",
    scope: row.scope,
    readAt: row.readAt === null ? null : new Date(row.readAt).toISOString(),
    link: row.link,
  };
}

/**
 * カーソルを通知 ID として確かめる
 * @param cursor 前の返事の meta.next
 * @throws malformed_request 通知 ID (UUID) でない時
 */
function parseCursor(cursor: string): void {
  // 読めないカーソルを先頭や末尾に読み替えず、要求の誤りとして断る
  if (!z.uuid().safeParse(cursor).success) throw new AppError("malformed_request", "カーソルが通知 ID でない");
}

/**
 * 通知を新しい順に読む。ID は UUID v7 で作った順に並ぶので、カーソルは前のページの最後の ID
 * @param db 主の D1
 * @param page 前のページの最後の ID と件数
 * @param page.cursor 前のページの最後の ID
 * @param page.limit 件数
 * @returns 通知と次のカーソル
 * @throws malformed_request カーソルが通知 ID でない時
 */
export async function listNotices(db: D1Database, page: { cursor?: string | undefined; limit: number }): Promise<{ items: Notice[]; next: string | null }> {
  if (page.cursor !== undefined) parseCursor(page.cursor);
  const rows = await drizzle(db)
    .select()
    .from(notices)
    .where(page.cursor === undefined ? undefined : lt(notices.id, page.cursor))
    .orderBy(desc(notices.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  return { items: items.map(toNotice), next: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
}

/**
 * 通知を既読にする。既読なら何もしない
 * @param db 主の D1
 * @param noticeId 通知 ID
 * @param now 今
 * @throws not_found 通知が無い時
 */
export async function markNoticeRead(db: D1Database, noticeId: string, now: number): Promise<void> {
  const orm = drizzle(db);
  const [row] = await orm.select({ id: notices.id }).from(notices).where(eq(notices.id, noticeId)).limit(1);
  if (!row) throw new AppError("not_found", "通知が無い");
  await orm.update(notices).set({ readAt: now }).where(and(eq(notices.id, noticeId), isNull(notices.readAt)));
}

/**
 * 401、403、429 が 5 分に 50 回を超えた事を、通知 denied_burst にする。同じ通知は、オーナーが読むまで重ねて出さない。足した時は配信の印で画面に届ける
 * @param env バインディング
 * @param at 超えた時刻
 * @param count 5 分の窓の数
 * @param clock 配信の印の時刻
 */
export async function noticeDenied(env: Bindings, at: number, count: number, clock: Clock): Promise<void> {
  const id = newId({ now: () => at });
  // 未読の同じ通知が無い時だけ 1 文で足す。GuardDO が起き直して数え直しても重ならない
  const res = await env.DB.prepare(
    "INSERT INTO notices (id, at, level, kind, title, body, scope) SELECT ?, ?, 'warn', 'denied_burst', ?, ?, 'office' WHERE NOT EXISTS (SELECT 1 FROM notices WHERE kind = 'denied_burst' AND read_at IS NULL)",
  )
    .bind(id, at, "断った要求が続いている", `401、403、429 が 5 分に ${String(count)} 回になった。送信元と道はログインの記録と監査ログで確かめる`)
    .run();
  if (res.meta.changes === 1) await announceNotice(env, id, clock);
}

/**
 * Claude の API の失敗が 5 分に 3 回に届いていれば、通知 claude_failing を出す。同じ通知は、オーナーが読むまで重ねて出さない
 * 失敗はエラーログ (error_events) の code claude_failed で数える
 * @param env バインディング
 * @param clock 時刻
 * @param last 最後の失敗。ステータスか、届かなかった時の code
 */
export async function noticeClaudeFailures(env: Bindings, clock: Clock, last: string): Promise<void> {
  const at = clock.now();
  const recent = await recordsOf(env, at)
    .prepare("SELECT count(*) AS n FROM error_events WHERE code = ? AND at > ?")
    .bind(CLAUDE_FAILED, at - CLAUDE_FAILURE_WINDOW_MS)
    .first<{ n: number }>();
  const count = recent?.n ?? 0;
  if (count < CLAUDE_FAILURE_LIMIT) return;
  // 未読の同じ通知が無い時だけ 1 文で足す。同時に届いた失敗が、どれも無いと読んでから足すと重なるため
  const id = newId(clock);
  const res = await env.DB.prepare(
    "INSERT INTO notices (id, at, level, kind, title, body, scope) SELECT ?, ?, 'warn', 'claude_failing', ?, ?, 'office' WHERE NOT EXISTS (SELECT 1 FROM notices WHERE kind = 'claude_failing' AND read_at IS NULL)",
  )
    .bind(id, at, "Claude の API の失敗が続いている", `5 分に ${String(count)} 回失敗した。最後は ${last}`)
    .run();
  if (res.meta.changes === 1) await announceNotice(env, id, clock);
}
