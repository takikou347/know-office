// 費用を数える 1 か所。日本時間の月ごとに、REC_<年> の Claude API の額と、Workers Paid と社員の働いた時間から見込む Cloudflare の額を足す (画面の全体の画面の一覧、エージェントの費用)
import { type CostHistory, type CostMonth, cloudflareMonthMicroUsd, jstDay } from "@know-office/core";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";

/** 日本時間は協定世界時に 9 時間を足した時刻 */
const JST_OFFSET_MS = 9 * 60 * 60_000;

/**
 * YYYY-MM の次の月
 * @param month YYYY-MM
 * @returns 次の月の YYYY-MM
 */
function nextMonth(month: string): string {
  const at = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
  return at.toISOString().slice(0, 7);
}

/**
 * バインドした REC_<年> ごとに、今までの Claude API の額を日本時間の月ごとに足す
 * @param env バインディング
 * @param now 今の時刻
 * @returns 月ごとの額
 */
async function claudeByMonth(env: Bindings, now: number): Promise<Map<string, number>> {
  const dbs = RECORD_BINDINGS.flatMap((name) => {
    const db = env[name];
    return db ? [db] : [];
  });
  const parts = await Promise.all(
    dbs.map(async (db) => {
      const { results } = await db
        .prepare("SELECT strftime('%Y-%m', (at + ?) / 1000, 'unixepoch') AS month, coalesce(sum(cost_micro_usd), 0) AS cost FROM usage WHERE at <= ? GROUP BY month")
        .bind(JST_OFFSET_MS, now)
        .all<{ month: string; cost: number }>();
      return results;
    }),
  );
  const sums = new Map<string, number>();
  // 年の境の月は 2 つの置き場にまたがるので、月で足し合わせる
  for (const r of parts.flat()) sums.set(r.month, (sums.get(r.month) ?? 0) + r.cost);
  return sums;
}

/**
 * 社員の働いた時間を日本時間の月ごとに足す。働いている間は社員ごとにコンテナが 1 つ動くと見る
 * @param env バインディング
 * @param today 日本時間の今日
 * @returns 月ごとの働いた時間 (ミリ秒)
 */
async function workedByMonth(env: Bindings, today: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare("SELECT substr(day, 1, 7) AS month, coalesce(sum(worked_ms), 0) AS worked FROM daily_totals WHERE day <= ? GROUP BY month")
    .bind(today)
    .all<{ month: string; worked: number }>();
  return new Map(results.map((r) => [r.month, r.worked]));
}

/**
 * 最初に記録のある月から今月までの費用を古い順に並べ、累計を足す。使わなかった月は Workers Paid だけにする
 * @param env バインディング
 * @param now 今の時刻
 * @returns 月ごとの費用と累計
 */
export async function costHistory(env: Bindings, now: number): Promise<CostHistory> {
  const today = jstDay(now);
  const current = today.slice(0, 7);
  const [claude, worked] = await Promise.all([claudeByMonth(env, now), workedByMonth(env, today)]);
  const first = [...claude.keys(), ...worked.keys(), current].toSorted()[0] ?? current;
  const months: CostMonth[] = [];
  for (let month = first; month <= current; month = nextMonth(month)) {
    const claudeMicroUsd = claude.get(month) ?? 0;
    const cloudflareMicroUsd = cloudflareMonthMicroUsd(worked.get(month) ?? 0);
    months.push({ month, claudeMicroUsd, cloudflareMicroUsd, totalMicroUsd: claudeMicroUsd + cloudflareMicroUsd });
  }
  const sum = (pick: (m: CostMonth) => number) => months.reduce((total, m) => total + pick(m), 0);
  return { months, claudeMicroUsd: sum((m) => m.claudeMicroUsd), cloudflareMicroUsd: sum((m) => m.cloudflareMicroUsd), totalMicroUsd: sum((m) => m.totalMicroUsd) };
}

/**
 * 100 万分の 1 ドルを、小数 6 桁のドルにする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.234567」
 */
const usd = (micro: number) => (micro / 1_000_000).toFixed(6);

/**
 * 費用の推移を CSV にする。月ごとの内訳の行と、最後に累計の行を置く。額はドルで小数 6 桁
 * @param history 費用の推移と累計
 * @returns CSV の文
 */
export function costCsv(history: CostHistory): string {
  const rows = [
    "month,claude_usd,cloudflare_usd,total_usd",
    ...history.months.map((m) => `${m.month},${usd(m.claudeMicroUsd)},${usd(m.cloudflareMicroUsd)},${usd(m.totalMicroUsd)}`),
    `累計,${usd(history.claudeMicroUsd)},${usd(history.cloudflareMicroUsd)},${usd(history.totalMicroUsd)}`,
  ];
  return `${rows.join("\n")}\n`;
}
