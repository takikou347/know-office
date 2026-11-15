// 週に 1 度のバッチ処理のテストの手伝い。止めた記録とエラーを置き、代わりの Claude API にバッチを終えさせ、GitHub の Issue の代わりを持つ (サービスと拡張の 3.6、3.7)
import { type Fetcher, newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach } from "vitest";
import type { ScriptedMessage } from "../../dev/claude.ts";
import { stops, stopUpdates } from "../../src/gate/db/main.ts";
import { fingerprintMark, type IssueTracker } from "../../src/gate/findings/tracker.ts";
import { type BatchKind, pollBatches, startBatch } from "../../src/gate/jobs/weekly.ts";
import { clockAt } from "../../src/gate/work/attendance.ts";
import { resetLedger } from "./d1.ts";
import { useWork, type WorkWorld } from "./work.ts";

export const DAY = 24 * 60 * 60_000;

/**
 * useWork に加えて、テストごとに REC_2026 と REC_2027 を空にする。週のバッチは前の週の記録を全部読むので、前のテストの記録を残さない
 * @returns テストの物
 */
export function useWeekly(): WorkWorld {
  const world = useWork();
  beforeEach(async () => {
    await resetLedger(world.d1.REC_2026);
    await resetLedger(world.d1.REC_2027);
  }, 30_000);
  return world;
}

/**
 * 2026 年 12 月の日本時間の時刻を返す。12 月 7 日は月曜で、前の週は 11 月 30 日から 12 月 6 日
 * @param day 日
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
export function dec(day: number, h = 0, m = 0): number {
  return Date.UTC(2026, 11, day, h - 9, m);
}

/** GitHub の Issue の代わりが持つ Issue */
export type FakeIssue = { repo: string; number: number; title: string; body: string; comments: string[]; closed: boolean };

/** GitHub の Issue の代わり */
export type FakeTracker = IssueTracker & {
  /** 作った Issue */
  issues: FakeIssue[];
  /** true なら作る時と書き足す時に失敗する */
  down: boolean;
  /** 作る前に挟む */
  beforeCreate: (() => Promise<void>) | null;
};

/**
 * GitHub の Issue の代わりを作る。本文に隠した指紋で探す
 * @returns 代わり
 */
export function fakeTracker(): FakeTracker {
  const tracker: FakeTracker = {
    issues: [],
    down: false,
    beforeCreate: null,
    findIssue: (repo, fingerprint) => Promise.resolve(tracker.issues.find((i) => i.repo === repo && i.body.includes(fingerprintMark(fingerprint)))?.number ?? null),
    createIssue: async (repo, input) => {
      await tracker.beforeCreate?.();
      if (tracker.down) throw new Error("GitHub に届かない");
      const number = tracker.issues.length + 1;
      tracker.issues.push({ repo, number, title: input.title, body: input.body, comments: [], closed: false });
      return number;
    },
    comment: (repo, number, body) => {
      if (tracker.down) return Promise.reject(new Error("GitHub に届かない"));
      tracker.issues.find((i) => i.repo === repo && i.number === number)?.comments.push(body);
      return Promise.resolve();
    },
    close: (repo, number) => {
      if (tracker.down) return Promise.reject(new Error("GitHub に届かない"));
      const issue = tracker.issues.find((i) => i.repo === repo && i.number === number);
      if (issue) issue.closed = true;
      return Promise.resolve();
    },
  };
  return tracker;
}

/**
 * 止めた記録か近かった記録を 1 件置く。判定があれば stop_updates にも置く
 * @param w テストの物
 * @param input 時刻、シグナル、種類、相手、判定
 * @param input.at 時刻
 * @param input.signal シグナル
 * @param input.kind stop か near
 * @param input.target 相手
 * @param input.verdict 判定
 * @returns 止めた記録の ID
 */
export async function addStop(w: WorkWorld, input: { at: number; signal: string; kind?: "stop" | "near"; target?: string; verdict?: "correct" | "false" }): Promise<string> {
  const id = newId(clockAt(input.at));
  const orm = drizzle(w.d1.DB);
  await orm.insert(stops).values({
    id,
    at: input.at,
    kind: input.kind ?? "stop",
    scope: "staff",
    target: input.target ?? "builder",
    signal: input.signal,
    measured: 3,
    threshold: 2,
    rulesVersion: 0,
    recentOpsKey: null,
    nodeProgress: null,
    externalSources: [],
    model: null,
    by: "system",
  });
  if (input.verdict) {
    await orm.insert(stopUpdates).values({ id: newId(clockAt(input.at + 1)), stopId: id, at: input.at + 1, kind: "verdict", by: "owner", verdict: input.verdict, reason: "見た" });
  }
  return id;
}

/**
 * エラーを error_events に置く。1 件ごとに 1 分ずらす
 * @param w テストの物
 * @param input 時刻、指紋、件数
 * @param input.at 最初の時刻
 * @param input.fingerprint 指紋
 * @param input.count 件数
 * @param input.route ルート
 * @param input.message エラーの文
 * @param input.level error か warn
 * @param input.code 失敗の種類
 */
export async function addErrors(
  w: WorkWorld,
  input: { at: number; fingerprint: string; count: number; route?: string; message?: string; level?: "error" | "warn"; code?: string },
): Promise<void> {
  const db = recordDb(w, input.at);
  if (input.count === 0) return;
  const statements = Array.from({ length: input.count }, (_, i) =>
    db
      .prepare("INSERT INTO error_events (id, at, source, level, code, message, route, status, fingerprint, trace_id) VALUES (?, ?, 'gate', ?, ?, ?, ?, 500, ?, NULL)")
      .bind(
        newId(clockAt(input.at + i * 60_000)),
        input.at + i * 60_000,
        input.level ?? "error",
        input.code ?? "internal",
        input.message ?? "TypeError: undefined を読んだ",
        input.route ?? "/api/v1/nodes",
        input.fingerprint,
      ),
  );
  await db.batch(statements);
}

/**
 * その時刻の年の記録の D1 を返す
 * @param w テストの物
 * @param at 時刻
 * @returns REC_2026 か REC_2027
 */
function recordDb(w: WorkWorld, at: number) {
  return new Date(at + 9 * 60 * 60_000).getUTCFullYear() === 2027 ? w.d1.REC_2027 : w.d1.REC_2026;
}

/**
 * ツールの呼び出しを tool_calls に置く。1 件ごとに 1 分ずらす
 * @param w テストの物
 * @param input 時刻、ツール、かかった時間の並び、相手
 * @param input.at 最初の時刻
 * @param input.tool ツールの名前
 * @param input.ms 1 件ずつのかかった時間
 * @param input.target 相手
 */
export async function addToolCalls(w: WorkWorld, input: { at: number; tool: string; ms: number[]; target?: string }): Promise<void> {
  const db = recordDb(w, input.at);
  if (input.ms.length === 0) return;
  await db.batch(
    input.ms.map((ms, i) =>
      db
        .prepare("INSERT INTO tool_calls (id, at, staff_id, node_id, scope, tool, op_kind, target, allowed, reason, ms, trace_id) VALUES (?, ?, 'builder', NULL, 'office', ?, 'shell.run', ?, 1, NULL, ?, NULL)")
        .bind(newId(clockAt(input.at + i * 60_000)), input.at + i * 60_000, input.tool, input.target ?? `pnpm test ${String(i)}`, ms),
    ),
  );
}

/**
 * Claude の呼び出しの使った量を usage に置く。1 件ごとに 1 分ずらす
 * @param w テストの物
 * @param input 時刻、社員、件数、1 件の入力と読み直しの割引のトークン、1 件の費用
 * @param input.at 最初の時刻
 * @param input.staffId 社員
 * @param input.count 件数
 * @param input.input 割引の無い入力のトークン
 * @param input.cacheRead 読み直しの割引で読んだトークン
 * @param input.costMicroUsd 1 件の費用
 */
export async function addUsage(w: WorkWorld, input: { at: number; staffId: string; count: number; input: number; cacheRead: number; costMicroUsd: number }): Promise<void> {
  const db = recordDb(w, input.at);
  if (input.count === 0) return;
  await db.batch(
    Array.from({ length: input.count }, (_, i) =>
      db
        .prepare(
          "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, request_id, waited_ms, trace_id) VALUES (?, ?, ?, NULL, 'office', 'claude-sonnet-5-5', ?, 100, ?, 0, ?, NULL, NULL, NULL)",
        )
        .bind(newId(clockAt(input.at + i * 60_000)), input.at + i * 60_000, input.staffId, input.input, input.cacheRead, input.costMicroUsd),
    ),
  );
}

/**
 * 週のバッチを始め、代わりの Claude API に答えさせて終えさせ、5 分後に結果を入れる
 * @param w テストの物
 * @param kind distill か findings
 * @param answer custom_id ごとの答え
 * @param tracker GitHub の Issue の代わり
 * @param at 始める時刻
 */
export async function runBatch(w: WorkWorld, kind: BatchKind, answer: (customId: string) => ScriptedMessage | "errored", tracker: IssueTracker, at: number): Promise<void> {
  const deps = { fetch: w.gate.fetch, tracker };
  const before = w.gate.claude.batches.length;
  await startBatch(w.gate.env, kind, deps, at);
  const batch = w.gate.claude.batches.at(-1);
  if (batch && w.gate.claude.batches.length > before) w.gate.claude.endBatch(batch.id, answer);
  await pollBatches(w.gate.env, deps, at + 5 * 60_000);
}

/**
 * 次の DB の batch を包む。wrangler の手元のバインディングは差し替えを受けないので、要求が読む env の側を包み、1 度呼んだら戻す
 * @param w テストの物
 * @param around 元の batch を受け、その前後に挟む動き
 * @param binding 包む D1。初期値は DB
 */
export function onNextBatch(w: WorkWorld, around: (run: () => Promise<unknown>) => Promise<unknown>, binding: "DB" | "REC_2026" = "DB"): void {
  const env = w.gate.env;
  const original = env[binding];
  if (!original) throw new Error(`${binding} が無い`);
  const wrapped = new Proxy(original, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop !== "batch") {
        const bound: unknown = value.bind(target);
        return bound;
      }
      return (...args: unknown[]): Promise<unknown> => {
        Object.assign(env, { [binding]: original });
        return around(async () => {
          const out: unknown = await Reflect.apply(value, target, args);
          return out;
        });
      };
    },
  });
  Object.assign(env, { [binding]: wrapped });
}

/**
 * JSON を文で返す Claude の答えを作る
 * @param value 答えの JSON
 * @param usage 使った量
 * @returns 積む答え
 */
export function answerJson(value: unknown, usage?: Record<string, number>): ScriptedMessage {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(usage ? { usage } : {}) };
}

/**
 * 外へ出た要求の宛先を並べる fetch で包む
 * @param fetch 包む fetch
 * @param seen 並べる先
 * @returns 包んだ fetch
 */
export function watchFetch(fetch: Fetcher, seen: string[]): Fetcher {
  return (url, init) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    return fetch(url, init);
  };
}
