// 蒸留。前の週の止めた記録と近かった記録を原因ごとにまとめてレビュー担当のモデルに送り、返った案を lessons に入れる (サービスと拡張の 3.6)
import { DistillAnswer, newId, OPUS } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { answerJson, BATCH_EFFORT, BATCH_MAX_TOKENS, type BatchRequest, type BatchResult, recordBatchUsage } from "../jobs/claude-batch.ts";
import type { BatchRow, WeekRange, WeeklyDeps, WeeklyJob } from "../jobs/weekly.ts";
import { clockAt } from "../work/attendance.ts";

/** 1 つの原因で送る記録の上限。多い原因も 1 件の要求に収める */
const MAX_RECORDS = 50;


/** 変わらない先頭の指示。毎週同じ文にして読み直しの割引に当てる */
const SYSTEM = [
  "あなたは know-office のレビュー担当。自動停止が止めた記録と、止めるのに近かった記録を、1 つの原因ごとに読む。",
  "同じ事が起きないように、次の 3 種類から 3 件までの案を出す。",
  "- prompt_rule: 社員の役目の説明文に足す決まり。staffId に president、builder、reviewer のどれかを入れる",
  "- threshold: 自動停止の基準の数値の直し。staffId は null",
  "- rule_tool: ルールの判断かツールの直し。staffId は null",
  "オーナーが誤って止めたと判定した記録が多い時は、基準を緩める案も考える。",
  '答えは JSON だけで返す: {"proposals":[{"kind":"...","staffId":null,"proposal":"..."}]}',
].join("\n");

/** batches の detail に置く、custom_id ごとの原因と元の記録 */
const Detail = z.object({ groups: z.array(z.object({ customId: z.string(), cause: z.string(), stopIds: z.array(z.string()) })) });

const StopLine = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.string(),
  scope: z.string(),
  target: z.string(),
  signal: z.string(),
  measured: z.number(),
  threshold: z.number(),
  verdicts: z.string().nullable(),
});

/**
 * 前の週の止めた記録と近かった記録を、シグナルごとにまとめて送る物を作る
 * @param env バインディング
 * @param range 前の週
 * @param maxRequests 送る原因の数の上限。記録の多い原因から送る
 * @returns 原因ごとの要求と、custom_id から原因と元の記録への対応。記録が無ければ null
 */
async function prepare(env: Bindings, range: WeekRange, maxRequests: number): Promise<{ requests: BatchRequest[]; detail: z.infer<typeof Detail> } | null> {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.at, s.kind, s.scope, s.target, s.signal, s.measured, s.threshold,
       (SELECT group_concat(u.verdict || ':' || coalesce(u.reason, ''), ' / ') FROM stop_updates u WHERE u.stop_id = s.id AND u.kind = 'verdict') AS verdicts
     FROM stops s WHERE s.at >= ? AND s.at < ? ORDER BY s.signal, s.at`,
  )
    .bind(range.from, range.to)
    .all();
  const lines = z.array(StopLine).parse(results);
  if (lines.length === 0) return null;
  const bySignal = new Map<string, z.infer<typeof StopLine>[]>();
  for (const line of lines) bySignal.set(line.signal, [...(bySignal.get(line.signal) ?? []), line]);
  const groups = [...bySignal.entries()]
    .toSorted(([ca, a], [cb, b]) => b.length - a.length || ca.localeCompare(cb))
    .slice(0, maxRequests)
    .map(([cause, items], i) => ({ customId: `c${String(i)}`, cause, items }));
  return {
    requests: groups.map((g) => ({
      customId: g.customId,
      model: OPUS,
      system: SYSTEM,
      prompt: [
        `原因: ${g.cause}`,
        `記録: ${String(g.items.length)} 件`,
        ...g.items
          .slice(0, MAX_RECORDS)
          .map((s) => `- ${s.kind === "stop" ? "止めた" : "近かった"} 範囲 ${s.scope} 相手 ${s.target} 数えた値 ${String(s.measured)} 基準 ${String(s.threshold)} 判定 ${s.verdicts ?? "無し"}`),
      ].join("\n"),
      maxTokens: BATCH_MAX_TOKENS, effort: BATCH_EFFORT,
    })),
    detail: { groups: groups.map((g) => ({ customId: g.customId, cause: g.cause, stopIds: g.items.map((s) => s.id) })) },
  };
}

/**
 * 返った案を lessons に入れ、batches の行を applied にする。同じ 1 回で書き、先に入れた方だけが使った量を残す
 * @param env バインディング
 * @param _deps 外へ頼む口。蒸留は使わない
 * @param row batches の行
 * @param results バッチの結果
 * @param now 今の時刻
 */
async function apply(env: Bindings, _deps: WeeklyDeps, row: BatchRow, results: BatchResult[], now: number): Promise<void> {
  const { groups } = Detail.parse(row.detail);
  const db = env.DB;
  const still = "EXISTS (SELECT 1 FROM batches WHERE id = ? AND status = 'submitted')";
  const inserts = results.flatMap((r) => {
    const group = groups.find((g) => g.customId === r.customId);
    const answer = DistillAnswer.safeParse(r.text === null ? null : answerJson(r.text));
    if (!group || !answer.success) return [];
    return answer.data.proposals.map((p, i) =>
      db
        .prepare(
          `INSERT INTO lessons (id, created_at, kind, cause, proposal, staff_id, stop_ids, status, applied_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL WHERE ${still}`,
        )
        .bind(newId(clockAt(now + i)), now, p.kind, group.cause, p.proposal, p.staffId, JSON.stringify(group.stopIds), row.id),
    );
  });
  // usage は年ごとの記録の D1 にあり、batches と同じ 1 回の batch に入れられない。先に重ねない形で残し、落ちたら applied にせず次に読み直す
  await recordBatchUsage(env, row.batchId, results, row.createdAt);
  const done = db.prepare("UPDATE batches SET status = 'applied', ended_at = ? WHERE id = ? AND status = 'submitted'").bind(now, row.id);
  await db.batch([...inserts, done]);
}

/** 蒸留の週のバッチ処理 */
export const DISTILL_JOB: WeeklyJob = { prepare, apply };
