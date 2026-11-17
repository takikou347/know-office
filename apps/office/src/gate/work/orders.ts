// その日だけの指示を確かめて足す。画面のボタンと会話の言葉の両方から使う (社員と勤怠の 3.4)
import { AppError, type CreateOrderInput, jstClock, jstDay, jstDayStart, type MessageOrder, newId, OrderKind, type StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { clockAt, type DayOrderRow, loadSchedule } from "./attendance.ts";

/**
 * HH:MM を 0 時からの分にする
 * @param hhmm 時刻
 * @returns 分
 */
function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * 指示の終わりの時刻を確かめる。日も時刻も今より後、延長は所定の終わりより後、早退は所定の終わりより前
 * @param db D1 の DB
 * @param input 指示
 * @param now 今の時刻
 * @returns 終わりの時刻。休みは null
 * @throws conflict 日か時刻を過ぎている、延長が終わりより前、早退が終わりより後の時
 */
export async function untilOf(db: Bindings["DB"], input: CreateOrderInput, now: number): Promise<number | null> {
  if (input.day < jstDay(now)) throw new AppError("conflict", "過ぎた日の指示は出せない");
  if (input.until === undefined) return null;
  const until = jstDayStart(input.day) + toMinutes(input.until) * 60_000;
  if (until <= now) throw new AppError("conflict", "指定の時刻を過ぎている");
  const end = jstDayStart(input.day) + toMinutes((await loadSchedule(db)).end) * 60_000;
  if (input.kind === "extend" && until <= end) throw new AppError("conflict", "延長は終わりの時刻より後にする");
  if (input.kind === "leave_early" && until >= end) throw new AppError("conflict", "早退は終わりの時刻より前にする");
  return until;
}

/**
 * 指示を確かめて day_orders に足す。同じ日の同じ種類の効いている指示が無い時だけ書く 1 文で、同時の 2 つの片方を断る
 * @param env バインディング
 * @param input 社員、指示、出した道、元の発言
 * @param input.staffId 社員 ID
 * @param input.order 指示
 * @param input.source ボタンか会話の言葉か
 * @param input.messageId 会話の言葉から足した時の元の発言 ID
 * @param now 今の時刻
 * @returns 足した行
 * @throws conflict 日か時刻を過ぎている、延長と早退の時刻が終わりの時刻と合わない、同じ日に同じ指示がある時
 */
export async function addOrder(
  env: Bindings,
  input: { staffId: StaffId; order: CreateOrderInput; source: "button" | "chat"; messageId: string | null },
  now: number,
): Promise<DayOrderRow> {
  const { staffId, order, source, messageId } = input;
  const until = await untilOf(env.DB, order, now);
  const row: DayOrderRow = { id: newId(clockAt(now)), staffId, day: order.day, kind: order.kind, until, source, cancels: null, createdAt: now, messageId };
  // 読んでから足すと、同時の 2 つがどちらも無いと読んで重なる
  const res = await env.DB.prepare(
    "INSERT INTO day_orders (id, staff_id, day, kind, until, source, cancels, created_at, message_id) SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM day_orders o WHERE o.staff_id = ? AND o.day = ? AND o.kind = ? AND o.cancels IS NULL AND NOT EXISTS (SELECT 1 FROM day_orders x WHERE x.cancels = o.id))",
  )
    .bind(row.id, staffId, order.day, order.kind, until, source, now, messageId, staffId, order.day, order.kind)
    .run();
  if (res.meta.changes !== 1) throw new AppError("conflict", "同じ日に同じ指示がある");
  return row;
}

/** D1 の 1 文に渡せる変数の上限 100 より少なく切る。出典: developers.cloudflare.com/d1/platform/limits */
const IN_CHUNK = 90;

type OrderLine = { id: string; message_id: string; kind: string; day: string; until: number | null; cancelled_at: number | null };

/**
 * 会話の言葉から足した指示を、元の発言ごとに読む。取り消した物は取り消した時刻を付ける
 * @param db 今の状態の D1
 * @param messageIds 発言 ID
 * @returns 発言 ID ごとの指示
 */
export async function ordersOfMessages(db: Bindings["DB"], messageIds: readonly string[]): Promise<Map<string, MessageOrder[]>> {
  const out = new Map<string, MessageOrder[]>();
  for (let i = 0; i < messageIds.length; i += IN_CHUNK) {
    const ids = messageIds.slice(i, i + IN_CHUNK);
    const rows = await db
      .prepare(
        `SELECT o.id, o.message_id, o.kind, o.day, o.until, (SELECT x.created_at FROM day_orders x WHERE x.cancels = o.id) AS cancelled_at FROM day_orders o WHERE o.cancels IS NULL AND o.message_id IN (${ids.map(() => "?").join(", ")}) ORDER BY o.id`,
      )
      .bind(...ids)
      .all<OrderLine>();
    for (const r of rows.results) {
      const order: MessageOrder = {
        id: r.id,
        kind: OrderKind.parse(r.kind),
        day: r.day,
        until: r.until === null ? null : jstClock(r.until),
        cancelledAt: r.cancelled_at === null ? null : new Date(r.cancelled_at).toISOString(),
      };
      out.set(r.message_id, [...(out.get(r.message_id) ?? []), order]);
    }
  }
  return out;
}

