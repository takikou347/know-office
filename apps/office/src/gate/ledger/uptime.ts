// 稼働の確かめ。5 分ごとの定期ジョブが部分ごとに通るかを health_checks に残し、故障と遅れを通知にし、記録の画面が読む月の稼働率をそこから出す (サービスと拡張の 3 章)
import { type Clock, jstDayStart, newId, type Uptime } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { announceNotice } from "../live/publish.ts";
import { recordError } from "./errors.ts";
import { activeStaff } from "../work/roster.ts";

/** 1 つの部分の答えを待つ長さの初期値。外を呼ぶ時の初期値と同じ 10 秒 */
const PROBE_TIMEOUT_MS = 10_000;

/** 答えたがこの長さを超えた部分は、遅れとして知らせる */
export const SLOW_PROBE_MS = 3_000;

/** 1 つの部分の確かめ。part は health_checks の part */
type Probe = { part: string; run: () => Promise<unknown> };

/**
 * 決めた長さの内に終わるかを待つ。間に合わなければ通らなかったとする。
 * DO の RPC と D1 の問い合わせは AbortSignal で中断できないので、時間切れは決めた長さで解ける Promise との競争で作る。
 * 時間切れの後も work() は走り続け、その結果は捨てる (確かめは読むだけなので、遅れて終わっても何も変えない)
 * @param work 確かめる処理
 * @param timeoutMs 待つ長さ
 * @returns 通ったか
 */
async function within(work: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
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
 * 確かめる部分を並べる。ゲートウェイ (このジョブが動いている事)、主の D1、記録 DO と年ごとの D1、在籍の社員の社員 DO。
 * ワークスペースは起こすと費用が出るので起こさず、社員 DO がハートビートで見る
 * @param env バインディング
 * @param now 今の時刻
 * @param people 在籍の社員
 * @returns 部分の並び
 */
function probes(env: Bindings, now: number, people: readonly { id: string }[]): Probe[] {
  return [
    { part: "gate", run: () => Promise.resolve() },
    { part: "d1", run: () => env.DB.prepare("SELECT 1").first() },
    { part: "recorder", run: () => env.RECORDER.get(env.RECORDER.idFromName("recorder")).size() },
    ...people.map(({ id }) => ({ part: `staff:${id}`, run: () => env.STAFF.get(env.STAFF.idFromName(id)).status(now) })),
  ];
}

/**
 * clock で測るストップウォッチを作る
 * @param clock 時刻
 * @returns 測り始め、答えまでの長さを返す関数を返す関数
 */
function clockStopwatch(clock: Clock): () => () => number {
  return () => {
    const started = clock.now();
    return () => clock.now() - started;
  };
}

/**
 * 部分ごとに通るかを確かめ、health_checks に 1 回のバッチで残し、答えなかった部分を故障、遅かった部分を遅れとして通知に入れる。
 * 確かめを書けない時も、通知を書けない時も、投げずにエラーログに残す。通知が書けなくても確かめの行とほかの部分の通知は残す
 * @param env バインディング
 * @param clock 時刻
 * @param options 確かめ方。省くと 10 秒待ち、clock で答えまでの長さを測る
 * @param options.timeoutMs 1 つの部分の答えを待つ長さ
 * @param options.stopwatch 部分ごとに測り始め、答えまでの長さを返す関数を返す
 */
export async function checkHealth(env: Bindings, clock: Clock, options: { timeoutMs?: number; stopwatch?: (part: string) => () => number } = {}): Promise<void> {
  const { timeoutMs = PROBE_TIMEOUT_MS, stopwatch = clockStopwatch(clock) } = options;
  const now = clock.now();
  const results = await Promise.all(
    probes(env, now, await activeStaff(env.DB).catch(() => [])).map(async (probe) => {
      const elapsed = stopwatch(probe.part);
      const ok = await within(probe.run, timeoutMs);
      return { part: probe.part, ok, ms: Math.max(0, elapsed()) };
    }),
  );
  try {
    const insert = env.DB.prepare("INSERT INTO health_checks (id, at, part, ok, ms) VALUES (?, ?, ?, ?, ?)");
    await env.DB.batch(results.map((r) => insert.bind(newId(clock), now, r.part, r.ok ? 1 : 0, r.ms)));
  } catch (error) {
    await recordError(env, { source: "job", level: "error", code: "health_check_failed", error }, clock);
  }
  for (const r of results) {
    const notice = r.ok ? (r.ms > SLOW_PROBE_MS ? slowNotice(r.part, r.ms) : null) : downNotice(r.part, timeoutMs);
    if (notice === null) continue;
    await noticeOnce(env, clock, notice).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "health_notice_failed", error }, clock));
  }
}

/** 稼働の通知の種類と文 */
type HealthNotice = { kind: "health_down" | "health_slow"; title: string; body: string };

/**
 * 答えなかった部分の通知を作る
 * @param part 部分
 * @param timeoutMs 待った長さ
 * @returns 通知
 */
function downNotice(part: string, timeoutMs: number): HealthNotice {
  // 題は、同じ部分の通知を重ねないための鍵も兼ねる
  return { kind: "health_down", title: `${part} が答えない`, body: `5 分ごとの確かめで ${String(timeoutMs / 1000)} 秒の内に答えなかった` };
}

/**
 * 答えが遅かった部分の通知を作る
 * @param part 部分
 * @param ms 答えまでの長さ
 * @returns 通知
 */
function slowNotice(part: string, ms: number): HealthNotice {
  return { kind: "health_slow", title: `${part} の答えが遅い`, body: `5 分ごとの確かめで答えまで ${(ms / 1000).toFixed(1)} 秒かかった` };
}

/**
 * 稼働の通知を足す。同じ種類と題の未読があれば足さない。足した時は配信の印で画面に届ける
 * @param env バインディング
 * @param clock 時刻
 * @param notice 通知
 */
async function noticeOnce(env: Bindings, clock: Clock, notice: HealthNotice): Promise<void> {
  const id = newId(clock);
  // 未読の同じ通知が無い時だけ 1 文で足す。同時に走った 2 つの確かめが、どちらも無いと読んでから足すと重なるため
  const res = await env.DB.prepare(
    "INSERT INTO notices (id, at, level, kind, title, body, scope, link) SELECT ?, ?, 'warn', ?, ?, ?, 'office', '/records' WHERE NOT EXISTS (SELECT 1 FROM notices WHERE kind = ? AND title = ? AND read_at IS NULL)",
  )
    .bind(id, clock.now(), notice.kind, notice.title, notice.body, notice.kind, notice.title)
    .run();
  if (res.meta.changes === 1) await announceNotice(env, id, clock);
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
