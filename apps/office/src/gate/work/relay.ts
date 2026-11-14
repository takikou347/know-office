// Claude のプロキシ。作業トークンを確かめた要求を、鍵を替えて Claude API へ流れのまま送り、使った量と上限の待ちを残す (社員が考えるの 3.3)
import { allowedFetch, allowedModels, AppError, type ClaudeUsage, costMicroUsd, log, newId, Secret, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { z } from "zod";
import { usage } from "../db/records.ts";
import { endpoints } from "../endpoints.ts";
import type { Bindings, GateEnv } from "../env.ts";
import { ensureRunning, staffOf } from "../guard/actions.ts";
import { observe } from "../guard/observe.ts";
import { rethrowRpc } from "../rpc.ts";
import { clockAt } from "./attendance.ts";
import { findNode, recordsOf } from "./nodes.ts";
import type { TicketClaims } from "./ticket.ts";

/** 送る道。Messages API とトークンを数える API だけ */
const MESSAGES = "/v1/messages";
const COUNT_TOKENS = "/v1/messages/count_tokens";

/** Claude API に引き継ぐ要求のヘッダー。鍵と作業トークンは引き継がない */
const REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"] as const;

/** ワークスペースに返す返事のヘッダー。Anthropic の頭のヘッダーのほかはこれだけ */
const RESPONSE_HEADERS = new Set(["content-type", "request-id", "retry-after", "x-should-retry"]);

/** 1 回の呼び出しを待つ上限。流れの返事は長く続くので、SDK の初期値と同じ 10 分にする */
const RELAY_TIMEOUT_MS = 10 * 60_000;

/** 要求の本文のうち、プロキシが確かめる所。ほかは変えずに送る */
const ClaudeRequest = z.looseObject({ model: z.string().min(1), stream: z.boolean().optional() });

/** 返事の使った量。読み直しの 2 つは無い事がある */
const UsageBody = z.looseObject({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
});

/** 流れの返事の頭の出来事。モデルと入力の使った量を持つ */
const MessageStart = z.looseObject({ type: z.literal("message_start"), message: z.looseObject({ model: z.string().optional(), usage: UsageBody.optional() }) });

/** 流れの返事の終わりの出来事。それまでの使った量の合計を持つ */
const MessageDelta = z.looseObject({ type: z.literal("message_delta"), usage: UsageBody.optional() });

/** 流れでない返事のうち、使った量を持つ所 */
const MessageBody = z.looseObject({ model: z.string().optional(), usage: UsageBody.optional() });

/** 返事から読んだ使った量。足りない項目は 0 */
type Metered = { model: string; usage: ClaudeUsage };

/** 1 回の呼び出しの記録に要る事 */
type Call = { staffId: StaffId; nodeId: string; requestId: string | null; waitedMs: number | null };

/**
 * Claude API の鍵を Secret に包んで読む
 * @param env バインディング
 * @returns 鍵
 * @throws unavailable 鍵が入っていない時
 */
function anthropicKey(env: Bindings): Secret {
  const key = env.ANTHROPIC_API_KEY ?? "";
  if (key === "") throw new AppError("unavailable", "Claude API の鍵が入っていない");
  return new Secret(key);
}

/**
 * 本文を読み、モデルが社員の役で許した物かを確かめる
 * @param text 本文
 * @param staffId 社員 ID
 * @returns 確かめた所
 * @throws malformed_request JSON でない時
 * @throws validation_failed モデルが無い時
 * @throws forbidden 役で許していないモデルの時
 */
function checkedBody(text: string, staffId: StaffId): z.infer<typeof ClaudeRequest> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError("malformed_request", "本文が JSON でない");
  }
  const parsed = ClaudeRequest.safeParse(json);
  if (!parsed.success) throw new AppError("validation_failed", "本文にモデルが無い");
  if (!allowedModels(staffId).includes(parsed.data.model)) throw new AppError("forbidden", "この役では使えないモデル");
  return parsed.data;
}

/**
 * Claude API に送るヘッダーを作る。作業トークンを外し、鍵を付ける
 * @param from ワークスペースの要求のヘッダー
 * @param key Claude API の鍵
 * @returns 送るヘッダー
 */
function upstreamHeaders(from: Headers, key: Secret): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = from.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-api-key", key.reveal());
  return headers;
}

/**
 * ワークスペースに返すヘッダーを選ぶ
 * @param from Claude API の返事のヘッダー
 * @returns 返すヘッダー
 */
function downstreamHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of from) {
    if (RESPONSE_HEADERS.has(name) || name.startsWith("anthropic-")) headers.set(name, value);
  }
  return headers;
}

/**
 * 返事の使った量を、足りない項目を 0 にして直す
 * @param body 返事の使った量
 * @returns 使った量
 */
function toUsage(body: z.infer<typeof UsageBody>): ClaudeUsage {
  return {
    inputTokens: body.input_tokens ?? 0,
    outputTokens: body.output_tokens ?? 0,
    cacheReadTokens: body.cache_read_input_tokens ?? 0,
    cacheWriteTokens: body.cache_creation_input_tokens ?? 0,
  };
}

/**
 * 使った量を usage に 1 行足し、自動停止に渡す。失敗しても返事は止めず、ログに残す
 * @param c 要求の文脈
 * @param call 社員、タスク、要求 ID、待っていた時間
 * @param metered 返事から読んだモデルと使った量
 */
async function recordUsage(c: Context<GateEnv>, call: Call, metered: Metered): Promise<void> {
  const env = c.env;
  const at = c.var.clock.now();
  try {
    const { scope } = await findNode(env.DB, call.nodeId);
    const { usage: u, model } = metered;
    await drizzle(recordsOf(env, at))
      .insert(usage)
      .values({
        id: newId(clockAt(at)),
        at,
        staffId: call.staffId,
        nodeId: call.nodeId,
        scope,
        model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        // 単価表に無いモデルは役で断るので来ない。来たら 0 で残し、ログで気付く
        costMicroUsd: costMicroUsd(model, u) ?? 0,
        requestId: call.requestId,
        waitedMs: call.waitedMs,
        traceId: c.var.traceId,
      });
    const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    await observe(env, { type: "usage", staffId: call.staffId, tokens }, at, c.var.guard, c.var.traceId);
  } catch (error) {
    log("error", "usage_record_failed", { staffId: call.staffId, nodeId: call.nodeId, traceId: c.var.traceId, error: error instanceof Error ? error.message : "unknown" });
  }
}

/**
 * 流れの返事を変えずに渡しながら、message_start と message_delta から使った量を読み、終わった所で記録する
 * @param model 要求のモデル。message_start に無い時に使う
 * @param done 終わった時に呼ぶ
 * @returns 流れを通す TransformStream
 */
function meter(model: string, done: (metered: Metered | null) => Promise<void>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let found: { model: string; usage: z.infer<typeof UsageBody> } | null = null;
  const read = (block: string) => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let json: unknown;
      try {
        json = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const start = MessageStart.safeParse(json);
      if (start.success) found = { model: start.data.message.model ?? model, usage: start.data.message.usage ?? {} };
      const delta = MessageDelta.safeParse(json);
      // message_delta の使った量はそれまでの合計なので、あった項目だけを上書きする
      if (delta.success && delta.data.usage && found) found = { ...found, usage: { ...found.usage, ...stripNull(delta.data.usage) } };
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) read(block);
    },
    async flush() {
      read(buffer + decoder.decode());
      const result: { model: string; usage: z.infer<typeof UsageBody> } | null = found;
      await done(result ? { model: result.model, usage: toUsage(result.usage) } : null);
    },
  });
}

/**
 * 値が null と undefined の項目を外す
 * @param body 使った量
 * @returns 値のある項目だけ
 */
function stripNull(body: z.infer<typeof UsageBody>): z.infer<typeof UsageBody> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * Claude API を呼ぶ。届かない時と時間切れは、鍵を含みうる中身を出さずに断る
 * @param c 要求の文脈
 * @param path 道
 * @param text 本文
 * @returns Claude API の返事
 * @throws unavailable 鍵が無い時
 * @throws upstream_timeout 10 分で返らない時
 * @throws upstream_failed 届かない時
 */
async function callUpstream(c: Context<GateEnv>, path: string, text: string): Promise<Response> {
  const base = endpoints(c.env).anthropic;
  const key = anthropicKey(c.env);
  // SDK は beta の Messages API を ?beta=true で呼ぶ。ほかのクエリは送らない
  const query = new URL(c.req.url).searchParams.get("beta") === "true" ? "?beta=true" : "";
  try {
    return await allowedFetch(c.var.fetch, `${base}${path}${query}`, [`${base}/`], {
      method: "POST",
      headers: upstreamHeaders(c.req.raw.headers, key),
      body: text,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new AppError("upstream_timeout", "Claude API が時間内に返らない");
    throw new AppError("upstream_failed", "Claude API に届かない");
  }
}

/**
 * 作業トークンを確かめた Claude への要求を処理する。止まっていれば断り、役のモデルを確かめ、鍵を替えて送り、返事を流れのまま返す
 * 返事の使った量を usage と自動停止に渡し、429 と 529 は勤怠の待ちに入れる。待ち直しは SDK に任せる
 * @param c 要求の文脈
 * @param ticket 確かめた作業トークン
 * @returns Claude API の返事
 * @throws not_found Messages API とトークンを数える API のほかの道の時
 * @throws stopped 全体、社員、タスクが止まっている時
 * @throws forbidden 役で許していないモデルの時
 * @throws malformed_request、validation_failed 本文の形が違う時
 */
export async function relayClaude(c: Context<GateEnv>, ticket: TicketClaims): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  if (c.req.method !== "POST" || (path !== MESSAGES && path !== COUNT_TOKENS)) throw new AppError("not_found", `${path} は存在しない`);
  await ensureRunning(c.env, ticket.staffId, ticket.nodeId);
  const text = await c.req.text();
  const body = checkedBody(text, ticket.staffId);
  const res = await callUpstream(c, path, text);
  const headers = downstreamHeaders(res.headers);
  const staff = staffOf(c.env, ticket.staffId);
  if (res.status === 429 || res.status === 529) {
    await staff.waitStart("rate_limit", c.var.clock.now()).catch(rethrowRpc);
    return new Response(res.body, { status: res.status, headers });
  }
  // トークンを数えるだけの呼び出しと失敗は、使った量に入れない
  if (path !== MESSAGES || !res.ok) return new Response(res.body, { status: res.status, headers });
  const { waitedMs } = await staff.waitEnd(c.var.clock.now());
  const call: Call = { staffId: ticket.staffId, nodeId: ticket.nodeId, requestId: res.headers.get("request-id"), waitedMs };
  if (res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const metered = res.body.pipeThrough(meter(body.model, (m) => (m ? recordUsage(c, call, m) : Promise.resolve())));
    return new Response(metered, { status: res.status, headers });
  }
  const answer = await res.text();
  const parsed = MessageBody.safeParse(safeJson(answer));
  if (parsed.success && parsed.data.usage) await recordUsage(c, call, { model: parsed.data.model ?? body.model, usage: toUsage(parsed.data.usage) });
  return new Response(answer, { status: res.status, headers });
}

/**
 * JSON として読む。読めなければ null
 * @param text 文
 * @returns 読んだ物
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
