// ゲートウェイが自分で Messages API を 1 回呼び、決めた tool を強いて答えさせ、使った量を残す。会話の言葉の指示と自動停止のレビュー担当が使う (社員と勤怠の 3.4、自動停止の 3.5)
import { allowedFetch, AppError, type ClaudeModel, type ClaudeUsage, costMicroUsd, type Fetcher, newId, type StaffId } from "@know-office/core";
import { z } from "zod";
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "./attendance.ts";
import { claudeKey } from "./claude-key.ts";
import { recordsOf } from "./nodes.ts";

/** Anthropic の API の版 */
const ANTHROPIC_VERSION = "2023-06-01";

/** 強いて呼ばせる tool。出典: platform.claude.com/docs/en/api/messages の tools と tool_choice */
export type ForcedTool = { name: string; description: string; input_schema: Record<string, unknown> };

/** 1 回の呼び出し */
export type ToolCall = {
  /** モデル */
  model: ClaudeModel;
  /** 答えの長さの上限 */
  maxTokens: number;
  /** 変わらない先頭の指示 */
  system: string;
  /** 強いて呼ばせる tool */
  tool: ForcedTool;
  /** 利用者の発言として渡す本文。データは JSON の文字列にして渡す */
  content: string;
  /** 待つ上限 */
  timeoutMs: number;
};

/** tool の入力と使った量。2xx でなければ投げるので、使った量はいつもある */
export type ToolReply = {
  /** tool の入力。形の違う返事、長さで切れた返事、tool を呼ばなかった返事は null */
  input: unknown;
  /** 使った量 */
  usage: ClaudeUsage;
};

const UsageBody = z.looseObject({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
});

const Reply = z.looseObject({
  stop_reason: z.string().nullish(),
  content: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })),
  usage: UsageBody.optional(),
});

/**
 * Messages API を 1 回呼び、決めた tool の入力を返す。送り直さない
 * @param env バインディング
 * @param fetch 外への fetch
 * @param call モデル、長さ、指示、tool、本文、待つ上限
 * @returns tool の入力と使った量
 * @throws unavailable 鍵が無い時、全体を止めた後でまだ入れ直していない時
 * @throws upstream_failed 届かない時か、2xx でない時
 */
export async function callTool(env: Bindings, fetch: Fetcher, call: ToolCall): Promise<ToolReply> {
  const secret = await claudeKey(env);
  const base = endpoints(env).anthropic;
  const headers = new Headers({ "anthropic-version": ANTHROPIC_VERSION, "x-api-key": secret.reveal(), "content-type": "application/json" });
  const body = {
    model: call.model,
    max_tokens: call.maxTokens,
    system: call.system,
    tools: [call.tool],
    tool_choice: { type: "tool", name: call.tool.name },
    messages: [{ role: "user", content: call.content }],
  };
  let res: Response;
  try {
    res = await allowedFetch(fetch, `${base}/v1/messages`, [`${base}/v1/`], { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(call.timeoutMs) });
  } catch {
    throw new AppError("upstream_failed", "Claude の API に届かない");
  }
  if (!res.ok) throw new AppError("upstream_failed", `Claude の API が ${String(res.status)} を返した`);
  const reply = Reply.safeParse(await res.json().catch(() => null));
  const usage = toUsage(reply.success ? reply.data.usage : undefined);
  if (!reply.success || reply.data.stop_reason === "max_tokens") return { input: null, usage };
  const used = reply.data.content.find((b) => b.type === "tool_use" && b.name === call.tool.name);
  return { input: used?.input ?? null, usage };
}

/**
 * 返事の使った量を、足りない項目を 0 にして直す
 * @param body 返事の使った量
 * @returns 使った量
 */
function toUsage(body: z.infer<typeof UsageBody> | undefined): ClaudeUsage {
  return {
    inputTokens: body?.input_tokens ?? 0,
    outputTokens: body?.output_tokens ?? 0,
    cacheReadTokens: body?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: body?.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: 0,
  };
}

/**
 * ゲートウェイが自分で呼んだ分の使った量を、記録の D1 の usage に 1 行足す。同じ requestId の行がもうあれば足さない
 * @param env バインディング
 * @param input 誰の分か、タスク、モデル、使った量、重ねない印、traceId
 * @param input.staffId その分を数える社員
 * @param input.nodeId タスク。無ければ null
 * @param input.model モデル
 * @param input.usage 使った量
 * @param input.requestId 重ねない印
 * @param input.traceId 呼んだ要求の traceId。無ければ null
 * @param now 今の時刻
 */
export async function recordGateUsage(
  env: Bindings,
  input: { staffId: StaffId; nodeId: string | null; model: ClaudeModel; usage: ClaudeUsage; requestId: string; traceId: string | null },
  now: number,
): Promise<void> {
  const u = input.usage;
  await recordsOf(env, now)
    .prepare(
      "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, request_id, waited_ms, trace_id) SELECT ?, ?, ?, ?, 'office', ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM usage WHERE request_id = ?)",
    )
    .bind(newId(clockAt(now)), now, input.staffId, input.nodeId, input.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, costMicroUsd(input.model, u), input.requestId, input.traceId, input.requestId)
    .run();
}
