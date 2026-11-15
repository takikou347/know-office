// 見つけて直す調べのうち、遅い所 (目安を超えたツールの呼び出し) と無駄な費用 (読み直しの割引が当たらなかった Claude の呼び出し) を記録から拾い、直した後の効き目を数える (サービスと拡張の 3.7)
import { sha256Hex, StaffId } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import type { WeekRange } from "../jobs/weekly.ts";
import { recordDbs } from "./records.ts";

/** 遅いとみなす 1 回のツールの呼び出しの目安 */
export const SLOW_MS = 60_000;

/** 遅い所として Issue にする、目安を超えた回数の週の下限 */
const SLOW_MIN_CALLS = 3;

/** 遅い所の Issue に並べる呼び出しの数 */
const SLOWEST = 10;

/** 割引が当たらなかった呼び出しの費用の週の下限。これより少なければ直す手間の方が高い */
const WASTE_MIN_MICRO_USD = 1_000_000;

/** 読み直しの割引に乗る最小の入力。これより短い呼び出しは割引が無くても無駄に数えない */
const CACHEABLE_TOKENS = 1024;

/** 1 回の呼び出しで、読み直しの割引で読んだ入力がこの割合より少なければ当たらなかったとする */
const CACHE_HIT_RATIO = 0.5;

/** 割引が当たらなかった呼び出しの条件 (usage の行) */
const WASTED = `(input_tokens + cache_read_tokens + cache_write_tokens) >= ${String(CACHEABLE_TOKENS)}
  AND cache_read_tokens < ${String(CACHE_HIT_RATIO)} * (input_tokens + cache_read_tokens + cache_write_tokens)`;

/** 遅い所と無駄な費用の 1 件。Issue の本文に根拠を並べる */
export type Signal = {
  /** slow か cost */
  kind: "slow" | "cost";
  /** 原因の指紋 */
  fingerprint: string;
  /** 目安を超えた回数か、割引が当たらなかった回数 */
  count: number;
  /** 最初の時刻 */
  firstAt: number;
  /** 最後の時刻 */
  lastAt: number;
  /** Claude に渡し、Issue に並べる根拠の行 */
  facts: string[];
};

const SlowTool = z.object({ tool: z.string(), n: z.number().int(), first_at: z.number(), last_at: z.number() });
const SlowCall = z.object({ tool: z.string(), target: z.string().nullable(), ms: z.number() });
const Waste = z.object({ staff_id: z.string(), n: z.number().int(), cost: z.number(), first_at: z.number(), last_at: z.number(), input: z.number(), cached: z.number() });

/**
 * 遅いツールの指紋を作る
 * @param tool ツールの名前
 * @returns SHA-256
 */
export function slowFingerprint(tool: string): Promise<string> {
  return sha256Hex(`slow|${tool}`);
}

/**
 * 割引が当たらない社員の指紋を作る
 * @param staffId 社員 ID
 * @returns SHA-256
 */
export function costFingerprint(staffId: string): Promise<string> {
  return sha256Hex(`cost|${staffId}`);
}

/**
 * 100 万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.23 ドル」
 */
function dollars(micro: number): string {
  return `${(micro / 1_000_000).toFixed(2)} ドル`;
}

/**
 * 前の週に目安を超えた呼び出しが下限以上あったツールを、遅い順の根拠と一緒に拾う。年をまたぐ週は年ごとの記録を合わせる
 * @param env バインディング
 * @param range 前の週
 * @returns ツールごとの遅い所
 */
export async function slowSignals(env: Bindings, range: WeekRange): Promise<Signal[]> {
  const tools = new Map<string, { n: number; firstAt: number; lastAt: number; calls: z.infer<typeof SlowCall>[] }>();
  for (const db of recordDbs(env, range.from, range.to)) {
    const { results } = await db
      .prepare("SELECT tool, count(*) AS n, min(at) AS first_at, max(at) AS last_at FROM tool_calls WHERE at >= ? AND at < ? AND ms > ? GROUP BY tool")
      .bind(range.from, range.to, SLOW_MS)
      .all();
    for (const t of z.array(SlowTool).parse(results)) {
      const was = tools.get(t.tool);
      const { results: calls } = await db
        .prepare("SELECT tool, target, ms FROM tool_calls WHERE tool = ? AND at >= ? AND at < ? AND ms > ? ORDER BY ms DESC, id LIMIT ?")
        .bind(t.tool, range.from, range.to, SLOW_MS, SLOWEST)
        .all();
      tools.set(t.tool, {
        n: (was?.n ?? 0) + t.n,
        firstAt: Math.min(was?.firstAt ?? t.first_at, t.first_at),
        lastAt: Math.max(was?.lastAt ?? t.last_at, t.last_at),
        calls: [...(was?.calls ?? []), ...z.array(SlowCall).parse(calls)],
      });
    }
  }
  const out: Signal[] = [];
  for (const [tool, t] of [...tools.entries()].toSorted(([a], [b]) => Number(a > b) - Number(a < b))) {
    if (t.n < SLOW_MIN_CALLS) continue;
    const slowest = t.calls.toSorted((a, b) => b.ms - a.ms).slice(0, SLOWEST);
    out.push({
      kind: "slow",
      fingerprint: await slowFingerprint(tool),
      count: t.n,
      firstAt: t.firstAt,
      lastAt: t.lastAt,
      facts: [
        `目安の ${String(SLOW_MS / 1000)} 秒を超えた回数: ${String(t.n)}`,
        "遅い順:",
        ...slowest.map((c, i) => `${String(i + 1)}. ${c.tool} ${String(Math.round(c.ms / 1000))} 秒: ${(c.target ?? "").slice(0, 200)}`),
      ],
    });
  }
  return out;
}

/**
 * 前の週に、読み直しの割引が当たらなかった呼び出しの費用が下限以上の社員を拾う
 * @param env バインディング
 * @param range 前の週
 * @returns 社員ごとの無駄な費用
 */
export async function costSignals(env: Bindings, range: WeekRange): Promise<Signal[]> {
  const staff = new Map<string, z.infer<typeof Waste>>();
  for (const db of recordDbs(env, range.from, range.to)) {
    const { results } = await db
      .prepare(
        `SELECT staff_id, count(*) AS n, sum(cost_micro_usd) AS cost, min(at) AS first_at, max(at) AS last_at,
           sum(input_tokens + cache_read_tokens + cache_write_tokens) AS input, sum(cache_read_tokens) AS cached
         FROM usage WHERE at >= ? AND at < ? AND ${WASTED} GROUP BY staff_id`,
      )
      .bind(range.from, range.to)
      .all();
    for (const w of z.array(Waste).parse(results)) {
      const was = staff.get(w.staff_id);
      staff.set(w.staff_id, {
        staff_id: w.staff_id,
        n: (was?.n ?? 0) + w.n,
        cost: (was?.cost ?? 0) + w.cost,
        first_at: Math.min(was?.first_at ?? w.first_at, w.first_at),
        last_at: Math.max(was?.last_at ?? w.last_at, w.last_at),
        input: (was?.input ?? 0) + w.input,
        cached: (was?.cached ?? 0) + w.cached,
      });
    }
  }
  const out: Signal[] = [];
  for (const w of [...staff.values()].toSorted((a, b) => Number(a.staff_id > b.staff_id) - Number(a.staff_id < b.staff_id))) {
    // 社員でない記録 (バッチ処理の office の分など) は説明文を直せないので拾わない
    if (!StaffId.safeParse(w.staff_id).success || w.cost < WASTE_MIN_MICRO_USD) continue;
    out.push({
      kind: "cost",
      fingerprint: await costFingerprint(w.staff_id),
      count: w.n,
      firstAt: w.first_at,
      lastAt: w.last_at,
      facts: [
        `社員: ${w.staff_id}`,
        `読み直しの割引が当たらなかった呼び出し: ${String(w.n)} 回、${dollars(w.cost)}`,
        `その呼び出しの入力のうち割引で読んだ割合: ${String(Math.round((w.cached / Math.max(w.input, 1)) * 100))}%`,
      ],
    });
  }
  return out;
}

/**
 * 遅い所か無駄な費用の指紋の、期間の回数を数える。直した後の効き目に使う
 * @param env バインディング
 * @param kind slow か cost
 * @param fingerprint 指紋
 * @param from 始め
 * @param to 終わり。含まない
 * @returns 目安を超えた回数か、割引が当たらなかった回数
 */
export async function countSignal(env: Bindings, kind: "slow" | "cost", fingerprint: string, from: number, to: number): Promise<number> {
  let total = 0;
  for (const db of recordDbs(env, from, to)) {
    if (kind === "slow") {
      // 指紋はツールの名前のハッシュなので、期間に目安を超えたツールから合う物を探す
      const { results } = await db.prepare("SELECT tool, count(*) AS n FROM tool_calls WHERE at >= ? AND at < ? AND ms > ? GROUP BY tool").bind(from, to, SLOW_MS).all();
      for (const t of z.array(z.object({ tool: z.string(), n: z.number() })).parse(results)) if ((await slowFingerprint(t.tool)) === fingerprint) total += t.n;
      continue;
    }
    for (const id of StaffId.options) {
      if ((await costFingerprint(id)) !== fingerprint) continue;
      const row = await db.prepare(`SELECT count(*) AS n FROM usage WHERE staff_id = ? AND at >= ? AND at < ? AND ${WASTED}`).bind(id, from, to).first<{ n: number }>();
      total += row?.n ?? 0;
    }
  }
  return total;
}
