// 社員 DO の勤務のテストの手伝い。時計を進め、DO の記憶と alarm、ワークスペースの代わりを置く
import { afterEach, beforeEach, expect } from "vitest";
import type { StaffId } from "@know-office/core";
import { StaffBook, type StaffStorage, type Workspace } from "../../src/gate/work/staff-book.ts";
import { createTestD1, type TestD1 } from "./d1.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = "2030-01-07";

/**
 * 2030-01-07 (日本時間) の時刻を返す。本物の時計より先の日にし、workerd の alarm がテストの間に鳴らないようにする
 * @param h 時
 * @param m 分
 * @param s 秒
 * @returns 協定世界時のミリ秒
 */
export function jst(h: number, m = 0, s = 0): number {
  return Date.UTC(2030, 0, 7, h - 9, m, s);
}

export const TASK = { nodeId: "0190f4a8-0000-7000-8000-000000000001", title: "ログインを直す", scope: "office" };
export const CALL_TASK = { nodeId: "0190f4a8-0000-7000-8000-000000000002", title: "急ぎの直し", scope: "know-office" };

/** 社員 1 人分の、DO の storage と alarm の代わり、ワークスペースの代わり */
export type Hired = {
  book: StaffBook;
  storage: StaffStorage & { alarm: number | null };
  workspace: string[];
  /** 最後に時計を進めた時刻 */
  at: number;
};

let d1: TestD1;

/**
 * 今のテストの D1 を返す
 * @returns DB
 */
export function testDb(): TestD1["DB"] {
  return d1.DB;
}

/**
 * その日だけの指示を day_orders に足す。ゲートウェイが StaffDO.order を呼ぶ前にする事
 * @param order 足す行
 * @param order.id 指示の ID
 * @param order.kind 種類
 * @param order.until 時刻
 * @param order.source button か chat
 * @param order.createdAt 出した時刻
 * @returns 足した行。StaffDO.order に渡す
 */
export async function addOrder(order: { id: string; kind: string; until: number | null; source: string; createdAt: number }) {
  const row = { ...order, staffId: "builder", day: DAY, cancels: null };
  await d1.DB.prepare("INSERT INTO day_orders (id, staff_id, day, kind, until, source, cancels, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.staffId, row.day, row.kind, row.until, row.source, row.cancels, row.createdAt)
    .run();
  return row;
}

/** 要件ごとの describe で、テストごとに空の D1 を作る。社員 DO のテストは workerd の D1 を使うので作らない */
export function useD1(): void {
  beforeEach(async () => {
    d1 = await createTestD1();
  }, 30_000);
  afterEach(() => d1.dispose());
}

/**
 * 社員を 1 人置く。storage を渡すと、同じ記憶で DO が起き直した形になる
 * @param staffId 社員 ID
 * @param storage 前の記憶
 * @returns 社員
 */
export function hire(staffId: StaffId = "builder", storage?: Hired["storage"]): Hired {
  const map = new Map<string, unknown>();
  const store: Hired["storage"] = storage ?? {
    alarm: null,
    get: (key) => Promise.resolve(structuredClone(map.get(key))),
    put: (key, value) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setAlarm: (at) => {
      store.alarm = at;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      store.alarm = null;
      return Promise.resolve();
    },
  };
  const calls: string[] = [];
  const workspace: Workspace = {
    start: () => Promise.resolve(void calls.push("start")),
    stop: () => Promise.resolve(void calls.push("stop")),
    wrapUp: () => Promise.resolve(void calls.push("wrapUp")),
    restart: () => Promise.resolve(void calls.push("restart")),
  };
  return { book: new StaffBook(staffId, store, d1.DB, workspace), storage: store, workspace: calls, at: jst(0) };
}

/**
 * 時計を to まで進める。ワークスペースは 30 秒ごとにハートビートを送り、alarm は掛かった時刻に鳴らす
 * @param s 社員
 * @param to 進める先
 * @param beats ハートビートを送るか
 */
export async function run(s: Hired, to: number, beats = true): Promise<void> {
  for (;;) {
    const beat = beats ? s.at + 30_000 : Infinity;
    const alarm = s.storage.alarm ?? Infinity;
    const next = Math.min(beat, alarm);
    if (next > to) break;
    s.at = next;
    if (alarm <= beat) await s.book.wake(alarm);
    else await s.book.heartbeat(beat);
  }
  s.at = to;
}

/**
 * D1 の行を読む
 * @param sql SQL
 * @returns 行
 */
export async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const result = await d1.DB.prepare(sql).all();
  return result.results;
}

/**
 * 社員の勤怠の行を始まりの順に、区分、時刻、理由だけにして読む
 * @param staffId 社員 ID
 * @returns 行
 */
export async function segments(staffId: StaffId = "builder") {
  return rows(`SELECT kind, started_at, ended_at, reason, day FROM attendance WHERE staff_id = '${staffId}' ORDER BY started_at`);
}

/**
 * 日ごとの集計を読む
 * @param staffId 社員 ID
 * @param day 日
 * @returns 集計の行
 */
export async function totals(staffId: StaffId = "builder", day = DAY) {
  const [row] = await rows(`SELECT * FROM daily_totals WHERE staff_id = '${staffId}' AND day = '${day}'`);
  return row;
}

/**
 * 9 時に出勤させ、タスクを取らせる
 * @param s 社員
 */
export async function startDay(s: Hired): Promise<void> {
  await s.book.wake(jst(8));
  s.at = jst(8);
  await run(s, jst(9));
  expect(await s.book.take(TASK, null, jst(9))).toEqual({ taken: true });
}
