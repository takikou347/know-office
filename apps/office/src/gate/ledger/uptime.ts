// 稼働の確かめ。5 分ごとの定期ジョブが部分ごとに通るかを health_checks に残し、記録の画面が読む月の稼働率をそこから出す (サービスと拡張の 3.5)
import { type Clock, jstDayStart, newId, StaffId, type Uptime } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { recordError } from "./errors.ts";

/** 1 つの部分の答えを待つ長さ。外を呼ぶ時の初期値と同じ 10 秒 */
const PROBE_TIMEOUT_MS = 10_000;

/** 1 つの部分の確かめ。part は health_checks の part */
type Probe = { part: string; run: () => Promise<unknown> };

/**
 * 決めた長さの内に終わるかを待つ。間に合わなければ通らなかったとする
 * @param work 確かめる処理
 * @returns 通ったか
 */
async function within(work: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work().then(() => true), late]);
  } catch {
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 確かめる部分を並べる。ゲートウェイ (このジョブが動いている事)、主の D1、記録 DO と年ごとの D1、3 つの社員 DO。
 * ワークスペースは起こすと費用が出るので起こさず、社員 DO がハートビートで見る
 * @param env バインディング
 * @param now 今の時刻
 * @returns 部分の並び
 */
function probes(env: Bindings, now: number): Probe[] {
  return [
    { part: "gate", run: () => Promise.resolve() },
    { part: "d1", run: () => env.DB.prepare("SELECT 1").first() },
    { part: "recorder", run: () => env.RECORDER.get(env.RECORDER.idFromName("recorder")).size() },
    ...StaffId.options.map((id) => ({ part: `staff:${id}`, run: () => env.STAFF.get(env.STAFF.idFromName(id)).status(now) })),
  ];
}

/**
 * 部分ごとに通るかを確かめ、health_checks に 1 回のバッチで残す。書けない時は投げずにエラーログに残す
 * @param env バインディング
 * @param clock 時刻
 */
export async function checkHealth(env: Bindings, clock: Clock): Promise<void> {
  const now = clock.now();
  const results = await Promise.all(
    probes(env, now).map(async (probe) => {
      const started = clock.now();
      const ok = await within(probe.run);
      return { part: probe.part, ok, ms: Math.max(0, clock.now() - started) };
    }),
  );
  try {
    const insert = env.DB.prepare("INSERT INTO health_checks (id, at, part, ok, ms) VALUES (?, ?, ?, ?, ?)");
    await env.DB.batch(results.map((r) => insert.bind(newId(clock), now, r.part, r.ok ? 1 : 0, r.ms)));
  } catch (error) {
    await recordError(env, { source: "job", level: "error", code: "health_check_failed", error }, clock);
  }
}

/**
 * 日本時間の月の稼働率を出す。件数と通った件数を 1 つの SQL で数える
 * @param env バインディング
 * @param month 日本時間の月 YYYY-MM
 * @returns 月と稼働率と件数
 */
export async function monthUptime(env: Bindings, month: string): Promise<Uptime> {
  const [year, mon] = month.split("-").map(Number);
  const next = mon === 12 ? `${String((year ?? 0) + 1)}-01` : `${String(year)}-${String((mon ?? 0) + 1).padStart(2, "0")}`;
  const row = await env.DB.prepare("SELECT count(*) AS checks, coalesce(sum(ok), 0) AS passed FROM health_checks WHERE at >= ? AND at < ?")
    .bind(jstDayStart(`${month}-01`), jstDayStart(`${next}-01`))
    .first<{ checks: number; passed: number }>();
  const checks = row?.checks ?? 0;
  return { month, ratio: checks === 0 ? null : (row?.passed ?? 0) / checks, checks };
}
