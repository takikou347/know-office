// 記録の集計。work_entries と usage を scope か社員ごとと全体で 1 つの SQL で数え、内訳の和を全体と合わせる (サービスと拡張の 3.4)
import type { D1Database } from "@cloudflare/workers-types";
import { jstYear, type RecordGroup, type RecordSummary, type RecordTotals } from "@know-office/core";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services, staff } from "../db/main.ts";

/** 集計の期間。協定世界時のミリ秒と日本時間の日。どちらの端も無ければ期間を決めない */
export type SummaryRange = {
  /** 始めの日 YYYY-MM-DD */
  from: string | null;
  /** 終わりの日 YYYY-MM-DD */
  to: string | null;
  /** 始めの日の 0 時 */
  start: number | null;
  /** 終わりの日の次の日の 0 時 */
  end: number | null;
};

const FIELDS = ["workedMs", "tasks", "costMicroUsd", "tokens", "deploys", "requests", "errors"] as const;
type Counts = Record<(typeof FIELDS)[number], number>;
type CountRow = { k: string | null } & Partial<Record<keyof Counts, number | null>>;

// 分け方ごとに、GROUP BY に使うカラム。SQL に埋めるのはこの決まった名前だけ
const COLUMNS = {
  service: { work: "scope", usage: "scope", deploy: "service_id" },
  staff: { work: "staff_id", usage: "staff_id", deploy: "by" },
} as const satisfies Record<RecordGroup, Record<string, string>>;

const ZERO: Counts = { workedMs: 0, tasks: 0, costMicroUsd: 0, tokens: 0, deploys: 0, requests: 0, errors: 0 };

/**
 * 内訳と全体を 1 つの文で出す SQL を組む。u の行を k ごとに足した行と、k が NULL の全体の行を返す
 * @param body u を作る CTE の中身
 * @param fields 足すカラム
 * @returns SQL
 */
function rollup(body: string, fields: readonly (keyof Counts)[]): string {
  const sums = fields.map((f) => `COALESCE(SUM(${f}), 0) AS ${f}`).join(", ");
  return `WITH u AS (${body}) SELECT k, ${sums} FROM u GROUP BY k UNION ALL SELECT NULL AS k, ${sums} FROM u`;
}

/**
 * DB の work_entries と service_events を数える。訂正された行は訂正した行に代える
 * @param db 今の状態の D1
 * @param group 分け方
 * @param range 期間
 * @returns k ごとの行と、k が NULL の全体の行
 */
async function countMain(db: D1Database, group: RecordGroup, range: SummaryRange): Promise<CountRow[]> {
  const col = COLUMNS[group];
  // 期間は日本時間の日で受け、work_entries は day で、出来事は時刻で絞る
  const body = `
    SELECT ${col.work} AS k, active_ms AS workedMs, CASE WHEN result = 'done' THEN 1 ELSE 0 END AS tasks, 0 AS deploys FROM work_entries
    WHERE id NOT IN (SELECT corrects FROM work_entries WHERE corrects IS NOT NULL) AND (?1 IS NULL OR day >= ?1) AND (?2 IS NULL OR day <= ?2)
    UNION ALL
    SELECT "${col.deploy}" AS k, 0, 0, 1 FROM service_events WHERE kind = 'deploy' AND (?3 IS NULL OR at >= ?3) AND (?4 IS NULL OR at < ?4)`;
  const res = await db.prepare(rollup(body, ["workedMs", "tasks", "deploys"])).bind(range.from, range.to, range.start, range.end).all<CountRow>();
  return res.results;
}

/**
 * その年の REC_<年> の usage と service_metrics を数える。社員ごとでは失敗率を出さないので service_metrics を読まない
 * @param db その年の記録の D1
 * @param group 分け方
 * @param range 期間
 * @returns k ごとの行と、k が NULL の全体の行
 */
async function countRecords(db: D1Database, group: RecordGroup, range: SummaryRange): Promise<CountRow[]> {
  const col = COLUMNS[group];
  const usage = `SELECT ${col.usage} AS k, cost_micro_usd AS costMicroUsd, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens AS tokens, 0 AS requests, 0 AS errors FROM usage WHERE (?1 IS NULL OR at >= ?1) AND (?2 IS NULL OR at < ?2)`;
  const metrics = `SELECT service_id AS k, 0, 0, requests, errors FROM service_metrics WHERE (?1 IS NULL OR at >= ?1) AND (?2 IS NULL OR at < ?2)`;
  const body = group === "service" ? `${usage} UNION ALL ${metrics}` : usage;
  const res = await db.prepare(rollup(body, ["costMicroUsd", "tokens", "requests", "errors"])).bind(range.start, range.end).all<CountRow>();
  return res.results;
}

/**
 * 数えた行を k ごとに足し込む
 * @param into 足し込む先。k が NULL の全体は "" の鍵に置く
 * @param rows 数えた行
 */
function add(into: Map<string, Counts>, rows: CountRow[]): void {
  for (const row of rows) {
    const key = row.k ?? "";
    const now = into.get(key) ?? { ...ZERO };
    for (const field of FIELDS) now[field] += row[field] ?? 0;
    into.set(key, now);
  }
}

/**
 * 足した数を返す形にする
 * @param c 足した数
 * @returns 時間、タスク、費用、トークン、デプロイ、失敗率
 */
function totalsOf(c: Counts): RecordTotals {
  return { workedMs: c.workedMs, tasks: c.tasks, costMicroUsd: c.costMicroUsd, tokens: c.tokens, deploys: c.deploys, failureRatio: c.requests === 0 ? 0 : c.errors / c.requests };
}

/**
 * 内訳に出す行の名前を、決まった順で並べる。service は office とサービス、staff は社員
 * @param db 今の状態の D1
 * @param group 分け方
 * @returns 鍵と名前の並び
 */
async function namesOf(db: D1Database, group: RecordGroup): Promise<[string, string][]> {
  if (group === "staff") {
    const rows = await drizzle(db).select({ id: staff.id, role: staff.role }).from(staff).orderBy(asc(staff.createdAt));
    return rows.map((r) => [r.id, r.role]);
  }
  const rows = await drizzle(db).select({ id: services.id, name: services.name }).from(services).orderBy(asc(services.createdAt));
  return [["office", "office"], ...rows.map((r): [string, string] => [r.id, r.name])];
}

/** その年の記録の D1 */
export type RecordDb = { year: number; db: D1Database };

/**
 * 記録を集計する。DB と、期間にかかる年の REC_<年> をそれぞれ 1 つの文で数え、内訳と全体を足し合わせる
 * @param db 今の状態の D1
 * @param recordDbs バインドした REC_<年>。usage を書く時と同じく年で選ぶ
 * @param group 分け方
 * @param range 期間
 * @returns 内訳と全体
 */
export async function summarize(db: D1Database, recordDbs: RecordDb[], group: RecordGroup, range: SummaryRange): Promise<RecordSummary> {
  const years = recordDbs.filter((r) => (range.start === null || r.year >= jstYear(range.start)) && (range.end === null || r.year <= jstYear(range.end - 1)));
  const [main, names, ...records] = await Promise.all([countMain(db, group, range), namesOf(db, group), ...years.map((r) => countRecords(r.db, group, range))]);
  const counts = new Map<string, Counts>();
  add(counts, main);
  for (const r of records) add(counts, r);
  const { "": total = { ...ZERO } } = Object.fromEntries(counts);
  counts.delete("");
  // 登録した物は記録が無くても 0 の行で出し、消えたサービスなど名前の無い記録も鍵のまま出して、和を全体と合わせる
  const known = new Map(names);
  const keys = [...known.keys(), ...[...counts.keys()].filter((k) => !known.has(k)).toSorted()];
  return {
    group,
    rows: keys.map((key) => ({ key, name: known.get(key) ?? key, ...totalsOf(counts.get(key) ?? ZERO) })),
    total: totalsOf(total),
  };
}

const CSV_COLUMNS = ["key", "name", "workedMs", "tasks", "costMicroUsd", "tokens", "deploys", "failureRatio"] as const;

/**
 * CSV の 1 つの値にする。表計算ソフトが式として読まないよう、式の頭の文字には ' を付ける
 * @param value 値
 * @returns RFC 4180 の値
 */
function cell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * 集計を CSV にする。頭の行、内訳、最後に全体の行。改行は RFC 4180 の CRLF
 * @param summary 集計
 * @returns CSV の文
 */
export function summaryCsv(summary: RecordSummary): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...summary.rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(",")),
    CSV_COLUMNS.map((c) => cell({ key: "total", name: "全体", ...summary.total }[c])).join(","),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
