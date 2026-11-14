// 画面に出す通知を読み、既読にし、続く Claude の失敗を通知にする (サービスと拡張の 3.5)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type Clock, newId, type Notice } from "@know-office/core";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { notices } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { recordsOf } from "../work/nodes.ts";

/** Claude の API の失敗を数える窓と、通知を出す回数。サービスと拡張の 3.5 */
export const CLAUDE_FAILURE_WINDOW_MS = 5 * 60_000;
export const CLAUDE_FAILURE_LIMIT = 3;

/** Claude の API の失敗をエラーログに残す時の code */
export const CLAUDE_FAILED = "claude_failed";

/**
 * 行を返す形に直す
 * @param row notices の行
 * @returns 通知
 */
function toNotice(row: typeof notices.$inferSelect): Notice {
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    level: row.level,
    kind: row.kind,
    title: row.title,
    body: row.body ?? "",
    scope: row.scope,
    readAt: row.readAt === null ? null : new Date(row.readAt).toISOString(),
  };
}

/**
 * 通知を新しい順に読む。ID は UUID v7 で作った順に並ぶので、カーソルは前のページの最後の ID
 * @param db 主の D1
 * @param page 前のページの最後の ID と件数
 * @param page.cursor 前のページの最後の ID
 * @param page.limit 件数
 * @returns 通知と次のカーソル
 */
export async function listNotices(db: D1Database, page: { cursor?: string | undefined; limit: number }): Promise<{ items: Notice[]; next: string | null }> {
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
  const orm = drizzle(env.DB);
  const [open] = await orm
    .select({ id: notices.id })
    .from(notices)
    .where(and(eq(notices.kind, "claude_failing"), isNull(notices.readAt)))
    .limit(1);
  if (open) return;
  await orm.insert(notices).values({
    id: newId(clock),
    at,
    level: "warn",
    kind: "claude_failing",
    title: "Claude の API の失敗が続いている",
    body: `5 分に ${String(count)} 回失敗した。最後は ${last}`,
    scope: "office",
  });
}
