// 週に 1 度のバッチ処理。前の週の記録をまとめて Claude のバッチ処理に送り、5 分ごとに終わりを見て結果を入れる (サービスと拡張の 3.6、3.7)
import { type Clock, type Fetcher, jstDay, jstDayStart, newId } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { syncIssues } from "../findings/scan.ts";
import type { IssueTracker } from "../findings/tracker.ts";
import { recordError } from "../ledger/errors.ts";
import { batchEnded, type BatchRequest, type BatchResult, batchResults, submitBatch } from "./claude-batch.ts";
import { DISTILL_JOB } from "../guard/distill.ts";
import { FINDINGS_JOB } from "../findings/scan.ts";

/** 日本時間の月曜 3 時。Cron は協定世界時で書くので日曜の 18 時になる。蒸留を始める */
export const DISTILL_CRON = "0 18 * * 0";

/** 日本時間の月曜 4 時。見つけて直す調べを始める */
export const FINDINGS_CRON = "0 19 * * 0";

const DAY = 24 * 60 * 60_000;

/** Cron の文字列から始める種類 */
const WEEKLY_CRONS = new Map<string, BatchKind>([
  [DISTILL_CRON, "distill"],
  [FINDINGS_CRON, "findings"],
]);

/** 始めた印を、送れずに残った物とみなすまでの間 */
const STALE_PENDING_MS = 30 * 60_000;

/** 週のバッチ処理の種類 */
export type BatchKind = "distill" | "findings";

/** 週のバッチ処理が外へ頼む口 */
export type WeeklyDeps = {
  /** 外への fetch。Claude のバッチ処理の API を呼ぶ */
  fetch: Fetcher;
  /** GitHub の Issue */
  tracker: IssueTracker;
};

/** 前の週。日本時間の月曜 0 時から次の月曜 0 時まで */
export type WeekRange = {
  /** 週の初めの月曜の日 (YYYY-MM-DD) */
  week: string;
  /** 始めの時刻 */
  from: number;
  /** 終わりの時刻。含まない */
  to: number;
};

/** batches の行のうち、結果を入れるのに使う所 */
export type BatchRow = { id: string; kind: BatchKind; week: string; batchId: string; detail: unknown };

/** 種類ごとの、送る物を作る口と結果を入れる口 */
export type WeeklyJob = {
  /**
   * 前の週の記録から送る物を作る。送る物が無ければ null
   * @param env バインディング
   * @param range 前の週
   * @returns 送る要求と、結果を入れる時に使う中身
   */
  prepare(env: Bindings, range: WeekRange): Promise<{ requests: BatchRequest[]; detail: unknown } | null>;
  /**
   * 終わったバッチの結果を入れる。batches の行を applied にするのと同じ 1 回で書き、先に入れた方だけが続きを行う
   * @param env バインディング
   * @param deps 外へ頼む口
   * @param row batches の行
   * @param results バッチの結果
   * @param now 今の時刻
   */
  apply(env: Bindings, deps: WeeklyDeps, row: BatchRow, results: BatchResult[], now: number): Promise<void>;
};

const JOBS: Record<BatchKind, WeeklyJob> = { distill: DISTILL_JOB, findings: FINDINGS_JOB };

const Pending = z.object({ id: z.string(), kind: z.enum(["distill", "findings"]), week: z.string(), batch_id: z.string(), detail: z.string().nullable() });

/**
 * 今の時刻から前の週を出す。今が月曜でなくても、今の週の前の週を返す
 * @param now 今の時刻
 * @returns 前の週
 */
export function previousWeek(now: number): WeekRange {
  const today = jstDay(now);
  // 日の文字列の曜日は時差によらない。月曜を 0 に数え直す
  const sinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const to = jstDayStart(today) - sinceMonday * DAY;
  const from = to - 7 * DAY;
  return { week: jstDay(from), from, to };
}

/**
 * 時刻を Clock にする
 * @param now 時刻
 * @returns その時刻を返す Clock
 */
function clockOf(now: number): Clock {
  return { now: () => now };
}

/**
 * 前の週のバッチ処理を始める。送る物が無い週、もう始めた週は何もしない。送れなかった時は始めた印を戻し、エラーログに残す
 * @param env バインディング
 * @param kind 種類
 * @param deps 外へ頼む口
 * @param now 今の時刻
 * @returns 始めた batches の行の ID。始めなかった時は null
 */
export async function startBatch(env: Bindings, kind: BatchKind, deps: WeeklyDeps, now: number): Promise<string | null> {
  const range = previousWeek(now);
  const prepared = await JOBS[kind].prepare(env, range);
  if (!prepared || prepared.requests.length === 0) return null;
  const id = newId(clockOf(now));
  // 送る前に落ちて残った印は、時間がたてば取り直せるようにする
  await env.DB.prepare("DELETE FROM batches WHERE kind = ? AND week = ? AND status = 'pending' AND created_at < ?").bind(kind, range.week, now - STALE_PENDING_MS).run();
  // 種類と週で 1 行だけを持てるので、同時に始めた 2 つの片方だけが送る
  const claimed = await env.DB.prepare("INSERT INTO batches (id, kind, week, batch_id, status, detail, created_at, ended_at) VALUES (?, ?, ?, NULL, 'pending', ?, ?, NULL) ON CONFLICT (kind, week) DO NOTHING")
    .bind(id, kind, range.week, JSON.stringify(prepared.detail), now)
    .run();
  if (claimed.meta.changes !== 1) return null;
  try {
    const batchId = await submitBatch(env, deps.fetch, prepared.requests);
    await env.DB.prepare("UPDATE batches SET batch_id = ?, status = 'submitted' WHERE id = ? AND status = 'pending'").bind(batchId, id).run();
    return id;
  } catch (error) {
    await env.DB.prepare("DELETE FROM batches WHERE id = ? AND status = 'pending'").bind(id).run();
    await recordError(env, { source: "job", level: "error", code: `${kind}_submit_failed`, error }, clockOf(now));
    return null;
  }
}

/**
 * 送ったバッチの終わりを見て、終わった物の結果を入れる。失敗はエラーログに残し、次の 5 分で読み直す
 * @param env バインディング
 * @param deps 外へ頼む口
 * @param now 今の時刻
 */
export async function pollBatches(env: Bindings, deps: WeeklyDeps, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, kind, week, batch_id, detail FROM batches WHERE status = 'submitted' ORDER BY id").all();
  for (const raw of results) {
    const parsed = Pending.safeParse(raw);
    if (!parsed.success) continue;
    const p = parsed.data;
    try {
      if (!(await batchEnded(env, deps.fetch, p.batch_id))) continue;
      const answers = await batchResults(env, deps.fetch, p.batch_id);
      const row: BatchRow = { id: p.id, kind: p.kind, week: p.week, batchId: p.batch_id, detail: p.detail === null ? null : (JSON.parse(p.detail) as unknown) };
      await JOBS[p.kind].apply(env, deps, row, answers, now);
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: `${p.kind}_apply_failed`, error }, clockOf(now));
    }
  }
  // 前の回に作れなかった Issue を作り直す
  await syncIssues(env, deps.tracker, now);
}

/**
 * 週の Cron なら、その種類のバッチ処理を始める。失敗は投げずにエラーログに残す
 * @param cron 呼ばれた Cron の文字列
 * @param env バインディング
 * @param ctx 返事の後も処理を続けさせる waitUntil
 * @param ctx.waitUntil 待たせる Promise を渡す
 * @param clock 時刻
 * @param deps 外へ頼む口
 * @returns 週の Cron だったら true
 */
export function runWeekly(cron: string, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }, clock: Clock, deps: WeeklyDeps): boolean {
  const kind = WEEKLY_CRONS.get(cron);
  if (kind === undefined) return false;
  ctx.waitUntil(startBatch(env, kind, deps, clock.now()).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: `${kind}_start_failed`, error }, clock)));
  return true;
}
