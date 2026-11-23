// Claude のバッチ処理の API を呼ぶ口。送る、終わったかを見る、結果を読む。急がないタスクはワークスペースを通さずここから回す (サービスと拡張の 3.6、社員が考えるの 3.4)
import { allowedFetch, AppError, batchCostMicroUsd, type ClaudeUsage, type Fetcher, newId, SONNET } from "@know-office/core";
import { z } from "zod";
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import { claudeKey } from "../work/claude-key.ts";
import { recordsOf } from "../work/nodes.ts";
import { pickStaff } from "../work/roster.ts";

/** Anthropic の API の版 */
const ANTHROPIC_VERSION = "2023-06-01";

/** バッチ処理の道 */
const BATCHES = "/v1/messages/batches";

/** 結果は大きくなりうるので、読むのは 1 分まで待つ */
const RESULTS_TIMEOUT_MS = 60_000;

/** バッチの ID。Anthropic が返す形だけを道に入れる */
export const BatchId = z.string().regex(/^msgbatch_[A-Za-z0-9]{1,64}$/);

/** custom_id。Anthropic が決めた形 */
export const CustomId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** 送る 1 件 */
export type BatchRequest = {
  /** 結果を合わせる鍵 */
  customId: string;
  /** モデル */
  model: string;
  /** 変わらない先頭の指示 */
  system: string;
  /** 1 件ごとの中身 */
  prompt: string;
  /** 答えの長さの上限。Opus 5.5 は考える分もここに入る */
  maxTokens: number;
  /** 考える深さ */
  effort: BatchEffort;
};

/** ゲートウェイのバッチ処理のモデル。決まった形の JSON を返すだけなので、月の予算に収めるため Sonnet にする */
export const BATCH_MODEL = SONNET;

/** 考える深さ。Opus 5.5 は考える事を切れないので、深さだけで費用を抑える (https://docs.claude.com/en/build-with-claude/effort) */
export type BatchEffort = "low" | "medium" | "high";

/** 週のバッチ処理と急ぐ故障の調べの答えの長さの上限。考える分を含めて、JSON の答えが切れない長さ */
export const BATCH_MAX_TOKENS = 8000;

/** 週のバッチ処理と急ぐ故障の調べの考える深さ。答えは決まった形の JSON なので浅くする */
export const BATCH_EFFORT: BatchEffort = "low";

/** 答えを入れなかった理由。errored は Anthropic の側の失敗、max_tokens は上限で切れた、refusal は断った */
export type BatchFailure = "errored" | "max_tokens" | "refusal";

/** 読んだ 1 件の結果。失敗した物は text が null。上限で切れた答えと断りは費用が出るので usage を持つ */
export type BatchResult = { customId: string; text: string | null; usage: ClaudeUsage | null; failure?: BatchFailure };

/** 返事が無いか 5xx で、送った要求が作られたか分からない時の印。送り直すと二重になる */
export const UNKNOWN_SUBMIT = "upstream_timeout";

const Created = z.looseObject({ id: z.string() });
const Status = z.looseObject({ processing_status: z.enum(["in_progress", "canceling", "ended"]) });
const UsageBody = z.looseObject({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
});
const Line = z.looseObject({
  custom_id: CustomId,
  result: z.union([
    z.looseObject({
      type: z.literal("succeeded"),
      message: z.looseObject({
        content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
        stop_reason: z.string().nullish(),
        usage: UsageBody.optional(),
      }),
    }),
    z.looseObject({ type: z.enum(["errored", "canceled", "expired"]) }),
  ]),
});

/**
 * 1 回呼ぶ。鍵を Secret から出してヘッダーに付け、決めた宛先だけを呼ぶ
 * @param env バインディング
 * @param fetch 外への fetch
 * @param path 道
 * @param init メソッドと本文
 * @param timeoutMs 待つ上限
 * @returns 返事
 * @throws unavailable 鍵が無い時、全体を止めた後でまだ入れ直していない時
 * @throws unauthenticated Claude の API が鍵を断った時 (401、403)
 * @throws not_found バッチが見つからない時 (404)
 * @throws rate_limited 上限 (429) か混み合い (529) の時
 * @throws upstream_timeout 返事が無い時か、作られたか分からない 5xx の時
 * @throws upstream_failed ほかの 4xx の時
 */
async function call(env: Bindings, fetch: Fetcher, path: string, init: { method: "GET" | "POST"; body?: string }, timeoutMs = 10_000): Promise<Response> {
  const secret = await claudeKey(env);
  const base = endpoints(env).anthropic;
  const headers = new Headers({ "anthropic-version": ANTHROPIC_VERSION, "x-api-key": secret.reveal() });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await allowedFetch(fetch, `${base}${path}`, [`${base}/`], { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new AppError(UNKNOWN_SUBMIT, "Claude のバッチ処理の API の返事が無い");
  }
  if (res.ok) return res;
  const shown = `Claude のバッチ処理の API が ${String(res.status)} を返した`;
  if (res.status === 401 || res.status === 403) throw new AppError("unauthenticated", shown);
  if (res.status === 404) throw new AppError("not_found", shown);
  // 上限の 429 と混み合いの 529 は受けておらず、待てば通る。ほかの 5xx は途中の物が返した事もあり、作られたか分からない (https://docs.claude.com/en/api/errors)
  if (res.status === 429 || res.status === 529) throw new AppError("rate_limited", shown);
  if (res.status >= 500) throw new AppError(UNKNOWN_SUBMIT, shown);
  throw new AppError("upstream_failed", shown);
}

/**
 * まとめた要求をバッチ処理に送る
 * @param env バインディング
 * @param fetch 外への fetch
 * @param requests 送る物
 * @returns バッチの ID
 * @throws unauthenticated 鍵を断られた時
 * @throws rate_limited 上限か混み合いで断られた時
 * @throws upstream_timeout 返事が無く、作られたか分からない時
 * @throws upstream_failed ほかの理由で断られた時、返った ID の形が違う時
 */
export async function submitBatch(env: Bindings, fetch: Fetcher, requests: BatchRequest[]): Promise<string> {
  const body = {
    requests: requests.map((r) => ({
      custom_id: CustomId.parse(r.customId),
      // 変わらない先頭の指示は毎回同じ形で置き、読み直しの割引に当てる
      params: { model: r.model, max_tokens: r.maxTokens, output_config: { effort: r.effort }, system: [{ type: "text", text: r.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: r.prompt }] },
    })),
  };
  const res = await call(env, fetch, BATCHES, { method: "POST", body: JSON.stringify(body) });
  const created = Created.safeParse(await res.json().catch(() => null));
  // 返った ID は次から道に入れるので、形の違う物は使わない
  const id = BatchId.safeParse(created.success ? created.data.id : null);
  if (!id.success) throw new AppError("upstream_failed", "バッチの ID の形が違う");
  return id.data;
}

/**
 * バッチ処理が終わったかを見る
 * @param env バインディング
 * @param fetch 外への fetch
 * @param batchId バッチの ID
 * @returns 終わっていれば true
 * @throws unauthenticated 鍵を断られた時
 * @throws not_found バッチが見つからない時
 * @throws upstream_failed 届かない時、形が違う時
 */
export async function batchEnded(env: Bindings, fetch: Fetcher, batchId: string): Promise<boolean> {
  const res = await call(env, fetch, `${BATCHES}/${BatchId.parse(batchId)}`, { method: "GET" });
  const status = Status.safeParse(await res.json().catch(() => null));
  if (!status.success) throw new AppError("upstream_failed", "バッチの様子の形が違う");
  return status.data.processing_status === "ended";
}

/**
 * 終わったバッチの結果を読む。結果の URL は返事のものを使わず、確かめた ID から組み立てる
 * @param env バインディング
 * @param fetch 外への fetch
 * @param batchId バッチの ID
 * @returns custom_id ごとの答えの文と使った量。形の違う行は除く
 * @throws upstream_failed 届かない時
 */
export async function batchResults(env: Bindings, fetch: Fetcher, batchId: string): Promise<BatchResult[]> {
  const res = await call(env, fetch, `${BATCHES}/${BatchId.parse(batchId)}/results`, { method: "GET" }, RESULTS_TIMEOUT_MS);
  const out: BatchResult[] = [];
  for (const raw of (await res.text()).split("\n")) {
    if (raw.trim() === "") continue;
    const line = Line.safeParse(safeJson(raw));
    if (!line.success) continue;
    const result = line.data.result;
    if (result.type !== "succeeded") {
      out.push({ customId: line.data.custom_id, text: null, usage: null, failure: "errored" });
      continue;
    }
    // 上限で切れた答えと断りは、読める JSON に見えても入れない
    const stop = result.message.stop_reason;
    const failure = stop === "max_tokens" || stop === "refusal" ? stop : undefined;
    const text = failure ? null : result.message.content.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join("");
    const u = result.message.usage;
    out.push({
      customId: line.data.custom_id,
      text,
      ...(failure ? { failure } : {}),
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
      },
    });
  }
  return out;
}

/**
 * バッチ処理の使った量を office の範囲で usage に残す。BATCH_MODEL で、1 件ずつの半額で数える。
 * 同じバッチを読み直して 2 度呼んでも、結果ごとに 1 行だけ残す
 * @param env バインディング
 * @param batchId バッチの ID
 * @param results バッチの結果
 * @param at 残す時刻。読み直しても変わらないよう、batches の行を作った時刻を渡す
 * @param job 使った職種。蒸留と調べはレビュー担当、アイデア出しは社長。在籍のその職種の社員の分にする
 */
export async function recordBatchUsage(env: Bindings, batchId: string, results: BatchResult[], at: number, job: "reviewer" | "president" = "reviewer"): Promise<void> {
  // その職種が居なくなっていても使った量は残す。最初の社員の ID に付ける
  const staffId = await pickStaff(env.DB, job).catch(() => job);
  const db = recordsOf(env, at);
  const statements = results.flatMap((r, i) => {
    if (!r.usage) return [];
    const requestId = `${batchId}:${r.customId}`;
    // usage_at の索引で引けるよう、時刻と要求の ID の両方で重なりを見る
    return [
      db
        .prepare(
          `INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, request_id, waited_ms, trace_id)
           SELECT ?, ?, ?, NULL, 'office', ?, ?, ?, ?, ?, ?, ?, NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM usage WHERE at = ? AND request_id = ?)`,
        )
        .bind(newId(clockAt(at + i)), at, staffId, BATCH_MODEL, r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheWriteTokens, batchCostMicroUsd(BATCH_MODEL, r.usage), requestId, at, requestId),
    ];
  });
  if (statements.length > 0) await db.batch(statements);
}

/**
 * JSON として読む
 * @param text 文
 * @returns 読んだ物。読めなければ undefined
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 答えの文から JSON を読む。json のコードブロックで囲んであれば外す
 * @param text 答えの文
 * @returns 読んだ物。読めなければ undefined
 */
export function answerJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return safeJson((fenced?.[1] ?? text).trim());
}
