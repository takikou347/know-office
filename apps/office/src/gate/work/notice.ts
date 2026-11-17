// 通知を、同じ種類と題の読んでいない物が無い時だけ足す。循環に入らない物だけを読むので、どこからも使える (サービスと拡張の 3.5)
import { newId, type NoticeLevel } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { announceNotice } from "../live/publish.ts";
import { clockAt } from "./attendance.ts";

/**
 * 通知を、同じ種類と題の読んでいない物が無い時だけ 1 文で足し、足した時は画面に配る。同じ時の 2 回でも 1 件になる
 * @param env バインディング
 * @param notice 種類、題、本文
 * @param notice.kind 種類
 * @param notice.title 題。重ねない鍵も兼ねる
 * @param notice.body 本文
 * @param now 今の時刻
 * @param level 重さ。初期値は warn
 */
export async function noticeOnce(env: Bindings, notice: { kind: string; title: string; body: string }, now: number, level: NoticeLevel = "warn"): Promise<void> {
  const id = newId(clockAt(now));
  const res = await env.DB
    .prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) SELECT ?, ?, ?, ?, ?, ?, 'office' WHERE NOT EXISTS (SELECT 1 FROM notices WHERE kind = ? AND title = ? AND read_at IS NULL)")
    .bind(id, now, level, notice.kind, notice.title, notice.body, notice.kind, notice.title)
    .run();
  // 足した時だけ画面に配る。画面は印を受けて通知を読み直す
  if (res.meta.changes === 1) await announceNotice(env, id, clockAt(now));
}
