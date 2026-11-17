// アイデア出しの週のバッチ処理。今のサービスと見送った案を社長のモデルに送り、返った案をアイデアの段階に足す。費用が出るので IDEA_BATCH が on の時だけ送る (weekly.ts の WEEKLY_LIMITS) (サービスと拡張の 3.1、3.6)
import { IdeaProposal, IdeasAnswer, newId, OPUS } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import { answerJson, BATCH_EFFORT, BATCH_MAX_TOKENS, type BatchRequest, type BatchResult, recordBatchUsage } from "./claude-batch.ts";
import type { BatchRow, WeekRange, WeeklyDeps, WeeklyJob } from "./weekly.ts";

/** 1 回のバッチで足す案の上限。要求は 1 件で、週に 1 回なので、1 日にもこれを超えない */
export const IDEAS_PER_BATCH = 3;

/** 社長のモデルに渡す今のサービスの上限。新しい物から渡す */
const MAX_SERVICES = 50;


/** 変わらない先頭の指示。毎週同じ文にして読み直しの割引に当てる */
const SYSTEM = [
  "あなたは know-office の社長。今あるサービスと見送った案を読み、重ならない新しいサービスの案を考える。",
  `案は ${String(IDEAS_PER_BATCH)} 件まで。kind は library、web_app、content のどれか。title は 100 字、aim は 2000 字、users は 500 字まで。`,
  "見送った案と同じ理由で見送られそうな案は出さない。",
  '答えは JSON だけで返す: {"ideas":[{"title":"...","kind":"library","aim":"...","users":"..."}]}',
].join("\n");

const ServiceLine = z.object({ name: z.string(), kind: z.string(), stage: z.string(), aim: z.string().nullable(), dropped_reason: z.string().nullable() });

/**
 * 今のサービスと見送った案を 1 件の要求にする。IDEA_BATCH が on でない時は startBatch が呼ばない
 * @param env バインディング
 * @param _range 前の週。案は週の記録によらず今のサービスから考える
 * @param maxRequests 送る要求の数の上限。0 なら送らない
 * @returns 1 件の要求。送らない時は null
 */
async function prepare(env: Bindings, _range: WeekRange, maxRequests: number): Promise<{ requests: BatchRequest[]; detail: null } | null> {
  if (maxRequests < 1) return null;
  const { results } = await env.DB.prepare("SELECT name, kind, stage, aim, dropped_reason FROM services ORDER BY id DESC LIMIT ?").bind(MAX_SERVICES).all();
  const lines = z.array(ServiceLine).parse(results);
  const prompt = [
    `今のサービスと案: ${String(lines.length)} 件`,
    ...lines.map((s) => `- ${s.name} (${s.kind}、段階 ${s.stage}) 狙い: ${s.aim ?? "無し"}${s.dropped_reason === null ? "" : ` 見送った理由: ${s.dropped_reason}`}`),
  ].join("\n");
  return { requests: [{ customId: "ideas", model: OPUS, system: SYSTEM, prompt, maxTokens: BATCH_MAX_TOKENS, effort: BATCH_EFFORT }], detail: null };
}

/**
 * 返った案を 1 件ずつ確かめ、頭から IDEAS_PER_BATCH 件までをアイデアの段階に足す。batches の行を applied にするのと同じ 1 回で書き、先に入れた方だけが足す
 * @param env バインディング
 * @param _deps 外へ頼む口。アイデア出しは使わない
 * @param row batches の行
 * @param results バッチの結果
 * @param now 今の時刻
 */
async function apply(env: Bindings, _deps: WeeklyDeps, row: BatchRow, results: BatchResult[], now: number): Promise<void> {
  const text = results.find((r) => r.customId === "ideas")?.text ?? null;
  const answer = IdeasAnswer.safeParse(text === null ? null : answerJson(text));
  const ideas = (answer.success ? answer.data.ideas : []).flatMap((raw) => {
    const idea = IdeaProposal.safeParse(raw);
    return idea.success ? [idea.data] : [];
  });
  const db = env.DB;
  const still = "EXISTS (SELECT 1 FROM batches WHERE id = ? AND status = 'submitted')";
  const inserts = ideas.slice(0, IDEAS_PER_BATCH).flatMap((idea, i) => {
    const serviceId = newId(clockAt(now + 2 * i));
    return [
      // 費用と売り上げの見込みは検討の段階で社員が調べるので、案の時は 0 で置く
      db
        .prepare(
          `INSERT INTO services (id, name, kind, stage, idea_id, repo, staff_id, aim, users, cost_estimate, revenue_estimate, study_key, dropped_reason, created_at) SELECT ?, ?, ?, 'idea', NULL, NULL, NULL, ?, ?, 0, 0, NULL, NULL, ? WHERE ${still}`,
        )
        .bind(serviceId, idea.title, idea.kind, idea.aim, idea.users, now, row.id),
      db
        .prepare(`INSERT INTO service_events (id, at, service_id, kind, by, detail) SELECT ?, ?, ?, 'stage', 'president', ? WHERE ${still}`)
        .bind(newId(clockAt(now + 2 * i + 1)), now, serviceId, JSON.stringify({ to: "idea", batch: row.batchId }), row.id),
    ];
  });
  // usage は年ごとの記録の D1 にあり、batches と同じ 1 回の batch に入れられない。先に重ねない形で残し、落ちたら applied にせず次に読み直す
  await recordBatchUsage(env, row.batchId, results, row.createdAt, "president");
  const done = db.prepare("UPDATE batches SET status = 'applied', ended_at = ? WHERE id = ? AND status = 'submitted'").bind(now, row.id);
  await db.batch([...inserts, done]);
}

/** アイデア出しの週のバッチ処理 */
export const IDEAS_JOB: WeeklyJob = { prepare, apply };
