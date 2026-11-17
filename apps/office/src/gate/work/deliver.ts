// オーナーの発言を社員に渡す。今の呼び出しに足すか、次の呼び出しの頭に足し、渡した印を発言 1 件に 1 行で残す (社員が考えるの 3.9)
import type { D1Database } from "@cloudflare/workers-types";
import { jstYear, log, type MessageDelivery, type OwnerMessage, ownerMessagesPrompt, type StaffId, type StaffState } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { announce } from "../live/publish.ts";
import { clockAt } from "./attendance.ts";
import { recordsOf } from "./nodes.ts";

/** 次の呼び出しの頭に足す発言の古さの上限 (24 時間)。前の日の勤務の外の発言まで届く長さ */
export const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 次の呼び出しの頭に足す発言の数の上限。1 件は D1 の頭の 2,000 字なので、10 件で 1 回の入力を 2 万字に収める */
export const DELIVERY_MAX = 10;

/** 24 時間のうちに読む発言の上限。渡した物を引いた残りから新しい 10 件を取る。新しい 200 件が全部渡し済みなら、その先の古い発言は印が付かず、24 時間を過ぎて skipped になるまで待ちのまま出る */
const DELIVERY_SCAN = 200;

/** IN に並べる ID の数の上限。D1 の 1 文のバインドは 100 まで */
const IN_CHUNK = 90;

/** 今の呼び出しに発言を足せる社員の状態。waiting はワークスペースを作り直す間で、続き (resumeRun) の頭で渡す */
const IN_RUN = new Set<StaffState>(["working", "wrapping", "called"]);

/** まだ渡していないオーナーの発言 1 件 */
export type PendingMessage = OwnerMessage & { id: string };

/** 渡した印 1 件 */
export type DeliveryMark = { via: MessageDelivery; at: number };

/** D1 の messages の行のうち渡すのに使う所 */
type PendingRow = { id: string; at: number; body: string; body_key: string | null };

/**
 * 発言を渡した印を ID で引く
 * @param db 今の状態の D1
 * @param ids メッセージ ID
 * @returns ID ごとの印
 */
export async function deliveriesOf(db: D1Database, ids: readonly string[]): Promise<Map<string, DeliveryMark>> {
  const found = new Map<string, DeliveryMark>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const rows = await db
      .prepare(`SELECT message_id, via, delivered_at FROM message_deliveries WHERE message_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ message_id: string; via: MessageDelivery; delivered_at: number }>();
    for (const row of rows.results) found.set(row.message_id, { via: row.via, at: row.delivered_at });
  }
  return found;
}

/**
 * 直近 24 時間の、まだ渡していないオーナーの発言を読む。24 時間前が前の年なら、前の年の記録の D1 も読む
 * 本文は D1 の頭の 2,000 字だけを使い、R2 は読まない
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @returns 新しい 10 件を古い順に並べた picked と、枠の外の skipped
 */
export async function undelivered(env: Bindings, staffId: StaffId, now: number): Promise<{ picked: PendingMessage[]; skipped: PendingMessage[] }> {
  const since = now - DELIVERY_WINDOW_MS;
  const dbs = jstYear(since) === jstYear(now) ? [recordsOf(env, now)] : [recordsOf(env, now), recordsOf(env, since)];
  const rows: PendingRow[] = [];
  for (const db of dbs) {
    const found = await db
      // 上は切らない。始めた後に読み直す時、始めた時刻より後に届いた発言も拾う
      .prepare("SELECT id, at, body, body_key FROM messages WHERE staff_id = ? AND sender = 'owner' AND at >= ? ORDER BY id DESC LIMIT ?")
      .bind(staffId, since, DELIVERY_SCAN)
      .all<PendingRow>();
    rows.push(...found.results);
  }
  const done = await deliveriesOf(env.DB, rows.map((r) => r.id));
  const open = rows
    .filter((r) => !done.has(r.id))
    .toSorted((a, b) => (a.id < b.id ? 1 : -1))
    .map((r): PendingMessage => ({ id: r.id, at: r.at, body: r.body, truncated: r.body_key !== null }));
  return { picked: open.slice(0, DELIVERY_MAX).toReversed(), skipped: open.slice(DELIVERY_MAX) };
}

/**
 * 渡した印を 1 文ずつの INSERT ... ON CONFLICT DO NOTHING でまとめて足し、新しく足した物だけを画面に配る。同じ発言を 2 か所から同時に印しても 1 行になる
 * @param env バインディング
 * @param target 社員とタスク
 * @param target.staffId 社員 ID
 * @param target.nodeId タスク ID
 * @param marks 発言 ID と道
 * @param now 今の時刻
 * @returns 新しく足した発言 ID
 */
export async function markDelivered(env: Bindings, target: { staffId: StaffId; nodeId: string | null }, marks: readonly { id: string; via: MessageDelivery }[], now: number): Promise<string[]> {
  if (marks.length === 0) return [];
  const insert = env.DB.prepare("INSERT INTO message_deliveries (message_id, staff_id, node_id, via, delivered_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING");
  const results = await env.DB.batch(marks.map((m) => insert.bind(m.id, target.staffId, target.nodeId, m.via, now)));
  const added = marks.filter((_, i) => results[i]?.meta.changes === 1);
  for (const m of added) await announce(env, { type: "message_delivered", delivery: { id: m.id, via: m.via, at: new Date(now).toISOString() } }, clockAt(now));
  return added.map((m) => m.id);
}

/**
 * 呼び出しの指示の後ろに、まだ渡していないオーナーの発言を足す
 * @param prompt 指示
 * @param picked 古い順の発言
 * @returns 発言を足した指示
 */
export function withOwnerMessages(prompt: string, picked: readonly PendingMessage[]): string {
  if (picked.length === 0) return prompt;
  return `${prompt}\n\nタスクの外で届いたオーナーの発言。読んで、このタスクの進め方に生かす。\n${ownerMessagesPrompt(picked)}`;
}

/**
 * 社員がタスク中なら、走っている呼び出しにオーナーの発言を足させ、受けたら印を付ける。止まったワークスペースは起こさない
 * 渡せない、印を付けられない時はログとエラーログに残して投げない。渡せなかった発言は次の呼び出しの頭で渡す
 * @param env バインディング
 * @param who 社員の状態
 * @param who.staffId 社員 ID
 * @param who.state 状態
 * @param who.nodeId 持っているタスク
 * @param message 発言
 * @param now 今の時刻
 * @returns 印を付けた時刻。渡していなければ null
 */
export async function deliverToRun(env: Bindings, who: { staffId: StaffId; state: StaffState; nodeId: string | null }, message: PendingMessage, now: number): Promise<number | null> {
  if (who.nodeId === null || !IN_RUN.has(who.state)) return null;
  try {
    const accepted = await env.WORKSPACE.get(env.WORKSPACE.idFromName(who.staffId)).message({ body: message.body, at: new Date(message.at).toISOString() });
    if (!accepted) return null;
    await markDelivered(env, { staffId: who.staffId, nodeId: who.nodeId }, [{ id: message.id, via: "run" }], now);
    return now;
  } catch (error) {
    log("warn", "message_deliver_failed", { staffId: who.staffId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    await recordError(env, { source: "gate", level: "warn", code: "message_deliver_failed", error }, clockAt(now));
    return null;
  }
}

/**
 * 呼び出しの頭に足すまだ渡していない発言を読む。読めなければ足さずに始め、ログとエラーログに残す
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @returns 足す発言と枠の外の発言
 */
export async function headMessages(env: Bindings, staffId: StaffId, now: number): Promise<{ picked: PendingMessage[]; skipped: PendingMessage[] }> {
  try {
    return await undelivered(env, staffId, now);
  } catch (error) {
    await recordError(env, { source: "gate", level: "warn", code: "message_read_failed", error }, clockAt(now));
    return { picked: [], skipped: [] };
  }
}

/**
 * 呼び出しを頼めた後に、頭に足した発言と枠の外の発言に印を付け、読んだ後に届いた発言を今の呼び出しに渡す
 * 印を付けられなくても投げない。印の無い発言は次の呼び出しでもう一度渡す (二重に読むのは許し、落とすのは許さない)
 * @param env バインディング
 * @param target 社員とタスク
 * @param target.staffId 社員 ID
 * @param target.nodeId タスク ID
 * @param head 頭に足した発言と枠の外の発言
 * @param head.picked 頭に足した発言
 * @param head.skipped 枠の外の発言
 * @param via 頭に足した発言の道
 * @param now 今の時刻
 */
export async function afterRunStarted(
  env: Bindings,
  target: { staffId: StaffId; nodeId: string },
  head: { picked: readonly PendingMessage[]; skipped: readonly PendingMessage[] },
  via: "run" | "next_task",
  now: number,
): Promise<void> {
  try {
    await markDelivered(env, target, [...head.picked.map((m) => ({ id: m.id, via })), ...head.skipped.map((m) => ({ id: m.id, via: "skipped" as const }))], now);
  } catch (error) {
    log("warn", "message_mark_failed", { staffId: target.staffId, nodeId: target.nodeId });
    await recordError(env, { source: "gate", level: "warn", code: "message_mark_failed", error }, clockAt(now));
  }
  // 読んだ後、呼び出しを頼むまでに届いた発言は、ワークスペースが 409 で断っていて、どこにも渡っていない
  const seen = new Set([...head.picked, ...head.skipped].map((m) => m.id));
  const late = (await headMessages(env, target.staffId, now)).picked.filter((m) => !seen.has(m.id));
  for (const message of late) await deliverToRun(env, { staffId: target.staffId, state: "working", nodeId: target.nodeId }, message, now);
}
