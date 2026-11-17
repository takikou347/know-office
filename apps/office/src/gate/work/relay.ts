// Claude のプロキシ。作業トークンを確かめた要求を、鍵を替えて Claude API へ流れのまま送り、使った量と上限の待ちを残す (社員が考えるの 3.4)
import { allowedFetch, allowedModels, AppError, PROBLEMS, type ClaudeModel, claudeSpendLimit, type ClaudeSpendLimit, type ClaudeUsage, costMicroUsd, log, newId, type Secret, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { z } from "zod";
import { usage } from "../db/records.ts";
import { endpoints } from "../endpoints.ts";
import type { GateEnv, Staff } from "../env.ts";
import { ensureRunning, staffOf } from "../guard/actions.ts";
import { observe } from "../guard/observe.ts";
import { CLAUDE_FAILED, recordError } from "../ledger/errors.ts";
import { noticeClaudeFailures } from "../ledger/notices.ts";
import { problemResponse } from "../problem.ts";
import { rethrowRpc } from "../rpc.ts";
import { clockAt } from "./attendance.ts";
import { noteRateLimit, noteSpendLimit } from "./claude-limits.ts";
import { claudeKey } from "./claude-key.ts";
import { findNode, recordsOf } from "./nodes.ts";
import type { TicketClaims } from "./ticket.ts";

/** 送る道。Messages API とトークンを数える API だけ */
const MESSAGES = "/v1/messages";
const COUNT_TOKENS = "/v1/messages/count_tokens";

/** Claude API に引き継ぐ要求のヘッダー。鍵と作業トークンは引き継がない */
const REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"] as const;

/** Claude のプロキシの返事に付ける印のヘッダー。forwarded は Claude API の返事、refused はプロキシが自分で断った返事。ワークスペースはこれで鍵の失敗とプロキシの断りを分ける */
export const RELAY_HEADER = "x-know-relay";

/** ワークスペースに返す返事のヘッダー。ほかは頭が anthropic-ratelimit- の物だけを返し、組織の ID などは出さない */
const RESPONSE_HEADERS = new Set(["content-type", "request-id", "retry-after", "x-should-retry"]);

/** 使用の上限かを読む返事のステータス。出典: platform.claude.com/docs/en/api/rate-limits の「Reaching your spend cap」「Setting your own spend limit」と /docs/en/api/errors の 402 */
const SPEND_STATUSES = new Set([400, 402, 429]);

/** 使用の上限かを読む本文の大きさの上限。失敗の本文は小さいので、超えた物は読まずにふつうの返事として扱う */
const SPEND_BODY_MAX_BYTES = 8 * 1024;

/** 1 回の呼び出しを待つ上限。流れの返事は長く続くので、SDK の初期値と同じ 10 分にする */
const RELAY_TIMEOUT_MS = 10 * 60_000;

/** 要求の本文のうち、プロキシが確かめる所。ほかは変えずに送る */
const ClaudeRequest = z.looseObject({ model: z.string().min(1) });

/** 返事の使った量。読み直しの項目は無い事がある。cache_creation は書き込みの 5 分と 1 時間の内訳 */
const UsageBody = z.looseObject({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation: z.looseObject({ ephemeral_1h_input_tokens: z.number().int().nonnegative().nullish() }).nullish(),
});

/** 返事の使った量の型 */
type UsageBody = z.infer<typeof UsageBody>;

/** 流れの返事の頭の出来事。入力の使った量を持つ */
const MessageStart = z.looseObject({ type: z.literal("message_start"), message: z.looseObject({ usage: UsageBody.optional() }) });

/** 流れの返事の終わりの出来事。それまでの使った量の合計を持つ */
const MessageDelta = z.looseObject({ type: z.literal("message_delta"), usage: UsageBody.optional() });

/** 流れでない返事のうち、使った量を持つ所 */
const MessageBody = z.looseObject({ usage: UsageBody.optional() });

/** 1 回の呼び出しの記録に要る事。費用と記録のモデルは、確かめて許した要求のモデル */
type Call = { staffId: StaffId; nodeId: string; model: ClaudeModel; requestId: string | null; waitedMs: number | null };

/**
 * 作業トークンを確かめた Claude への要求を処理する。止まっていれば断り、役のモデルを確かめ、鍵を替えて送り、返事を流れのまま返す
 * 返事の使った量を usage と自動停止に渡し、429 と 529 は勤怠の待ちに入れる。待ち直しは SDK に任せる
 * 使用の上限 (サービスと拡張の 3.5) は待ちに入れず、待ち直させない印を付けて返し、通知を出す
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
  const model = checkedModel(text, ticket.staffId);
  let res: Response;
  try {
    res = await callUpstream(c, path, text);
  } catch (error) {
    // 届かない失敗はここで数えて返す。onError に任せると upstream_failed として別に残り、二重に数える
    if (!(error instanceof AppError) || error.code === "unavailable") throw error;
    await noteClaudeFailure(c, path, PROBLEMS[error.code].status, error);
    return problemResponse(c, error);
  }
  const headers = downstreamHeaders(res.headers);
  const staff = staffOf(c.env, ticket.staffId);
  if (SPEND_STATUSES.has(res.status)) {
    const read = await readSpendLimit(res);
    res = read.res;
    if (read.limit) {
      await noteSpendLimit(c.env, c.var.clock, read.limit, { route: path, status: res.status, traceId: c.var.traceId });
      // 待っても直らないので、SDK に待ち直させない。社員を待ちに入れず、待っていれば次の成功で解く
      headers.set("x-should-retry", "false");
      return new Response(res.body, { status: res.status, headers });
    }
  }
  if (res.status === 429 || res.status === 529) {
    await staff.waitStart("rate_limit", c.var.clock.now()).catch(rethrowRpc);
    // 529 の混み合いは数えず、レートの上限の 429 だけを数える
    if (res.status === 429) await noteRateLimit(c.env, c.var.clock, res.headers, { route: path, status: 429, traceId: c.var.traceId });
    return new Response(res.body, { status: res.status, headers });
  }
  // 529 の混み合いは上の待ちで扱い、ほかの 500 台を Claude の API の失敗として数える
  if (res.status >= 500) await noteClaudeFailure(c, path, res.status, new Error(`Claude API が ${String(res.status)} を返した`));
  // トークンを数えるだけの呼び出しと失敗は、使った量に入れず、待ちも解かない
  if (path !== MESSAGES || !res.ok) return new Response(res.body, { status: res.status, headers });
  const waitedMs = await endWait(c, staff, ticket.staffId);
  const call: Call = { staffId: ticket.staffId, nodeId: ticket.nodeId, model, requestId: res.headers.get("request-id"), waitedMs };
  if (res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return new Response(meteredStream(res.body, (found) => recordUsage(c, call, found), laterOf(c)), { status: res.status, headers });
  }
  const answer = await res.text();
  const parsed = MessageBody.safeParse(safeJson(answer));
  if (parsed.success && parsed.data.usage) await recordUsage(c, call, parsed.data.usage);
  return new Response(answer, { status: res.status, headers });
}

/**
 * Claude の API の失敗をエラーログに残し、5 分に 3 回に届いていれば通知を出す。通知を出せなくても返事は止めず、ログに残す
 * @param c 要求の文脈
 * @param path 道
 * @param status 返したステータス
 * @param error 失敗
 */
async function noteClaudeFailure(c: Context<GateEnv>, path: string, status: number, error: Error): Promise<void> {
  await recordError(c.env, { source: "gate", level: "error", code: CLAUDE_FAILED, error, route: path, status, traceId: c.var.traceId }, c.var.clock);
  await noticeClaudeFailures(c.env, c.var.clock, String(status)).catch((cause: unknown) => {
    log("error", "claude_failure_notice_failed", { traceId: c.var.traceId, error: cause instanceof Error ? cause.message : "unknown" });
  });
}

/**
 * 失敗の本文を 8KB を超えるまで読み、使用の上限かを見分ける。読んだ分と残りで返事を作り直すので、本文は欠けない
 * @param res Claude API の返事
 * @returns 作り直した返事と、使用の上限なら見分けた物。8KB を超える本文、JSON でない本文、形の違う本文は null
 * @throws upstream_failed 本文の流れが途中で切れた時
 */
async function readSpendLimit(res: Response): Promise<{ res: Response; limit: ClaudeSpendLimit | null }> {
  if (!res.body) return { res, limit: null };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // 上限を超えるまでだけ読む。大きな本文をゲートウェイの記憶に載せない
    while (size <= SPEND_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        const text = new TextDecoder().decode(concatBytes(chunks, size));
        return { res: new Response(text, { status: res.status, headers: res.headers }), limit: claudeSpendLimit(res.status, safeJson(text)) };
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    // 流れが途中で切れた時は、SDK が待ち直せる 502 で返す
    log("warn", "claude_error_body_unreadable", { status: res.status, error: error instanceof Error ? error.message : "unknown" });
    throw new AppError("upstream_failed", "Claude API の返事を読めなかった");
  }
  // 上限を超えた本文は使用の上限と見ず、読んだ分と残りの流れをつないで欠かさずに返す
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { res: new Response(rest, { status: res.status, headers: res.headers }), limit: null };
}

/**
 * バイトの並びを 1 つにつなぐ
 * @param chunks 並び
 * @param size 合計の長さ
 * @returns つないだ並び
 */
function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 本文を読み、モデルが社員の役で許した物かを確かめる
 * @param text 本文
 * @param staffId 社員 ID
 * @returns 許したモデル
 * @throws malformed_request JSON でない時
 * @throws validation_failed モデルが無い時
 * @throws forbidden 役で許していないモデルの時
 */
function checkedModel(text: string, staffId: StaffId): ClaudeModel {
  const json = safeJson(text);
  if (json === undefined) throw new AppError("malformed_request", "本文が JSON でない");
  const parsed = ClaudeRequest.safeParse(json);
  if (!parsed.success) throw new AppError("validation_failed", "本文にモデルが無い");
  const model = allowedModels(staffId).find((m) => m === parsed.data.model);
  if (!model) throw new AppError("forbidden", "この役では使えないモデル");
  return model;
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
 * Claude API を呼ぶ。届かない時と時間切れは、鍵を含みうる中身を出さずに断る
 * @param c 要求の文脈
 * @param path 道
 * @param text 本文
 * @returns Claude API の返事
 * @throws unavailable 鍵が無い時、全体を止めた後でまだ入れ直していない時
 * @throws upstream_timeout 10 分で返らない時
 * @throws upstream_failed 届かない時
 */
async function callUpstream(c: Context<GateEnv>, path: string, text: string): Promise<Response> {
  const base = endpoints(c.env).anthropic;
  const key = await claudeKey(c.env);
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
    if (RESPONSE_HEADERS.has(name) || name.startsWith("anthropic-ratelimit-")) headers.set(name, value);
  }
  // Claude API の返事の同じ名前のヘッダーは引き継がないので、印は偽れない
  headers.set(RELAY_HEADER, "forwarded");
  return headers;
}

/**
 * 上限の待ちを解き、待っていた時間を返す。社員 DO に届かなくても返事と記録は止めず、エラーログに残す
 * @param c 要求の文脈
 * @param staff 社員 DO
 * @param staffId 社員 ID
 * @returns 待っていた時間。待っていない時と、解けなかった時は null
 */
async function endWait(c: Context<GateEnv>, staff: Staff, staffId: StaffId): Promise<number | null> {
  try {
    return (await staff.waitEnd(c.var.clock.now())).waitedMs;
  } catch (error) {
    log("error", "wait_end_failed", { staffId, traceId: c.var.traceId, error: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * 流れの返事を変えずに渡しながら、message_start と message_delta から使った量を読む
 * 読み終えた時、ワークスペースが切った時、Claude API の流れが落ちた時のどれでも、message_start を受けていれば 1 度だけ記録する
 * @param source Claude API の流れ
 * @param record 記録する口
 * @param later 切られた後の記録を、返事の後も走らせる口
 * @returns ワークスペースに返す流れ
 */
function meteredStream(source: ReadableStream<Uint8Array>, record: (found: UsageBody) => Promise<void>, later: (task: Promise<void>) => Promise<void>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let found: UsageBody | null = null;
  // 切った時に上流の読み出しが終わりを返し、pull の側でも記録が始まる。どちらから呼んでも同じ 1 本を待つ
  let recorded: Promise<void> | null = null;
  const read = (blocks: string[]) => {
    for (const block of blocks) found = foldUsage(found, block);
  };
  const finish = (): Promise<void> => {
    recorded ??= (async () => {
      read([buffer + decoder.decode()]);
      if (found) await record(found);
    })();
    return recorded;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // 上流の失敗と 10 分の時間切れ。届いた所までを記録してから、ワークスペースに失敗を渡す
        await finish();
        controller.error(error);
        return;
      }
      if (chunk.done) {
        await finish();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      read(blocks);
    },
    async cancel(reason) {
      // ワークスペースが切った。切った要求はここで終わるので、上流を止めて届いた所までを記録するのは waitUntil に渡す
      await later(
        (async () => {
          await reader.cancel(reason).catch(() => undefined);
          await finish();
        })(),
      );
    },
  });
}

/**
 * 返事の後も処理を走らせる口を作る。受け手が ctx を渡していれば waitUntil に渡し、無ければその場で待つ
 * @param c 要求の文脈
 * @returns 処理を受け取る口
 */
function laterOf(c: Context<GateEnv>): (task: Promise<void>) => Promise<void> {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null;
  try {
    ctx = c.executionCtx;
  } catch {
    // Hono は ctx が無い時に executionCtx を読むと投げる
    ctx = null;
  }
  if (ctx === null) return (task) => task;
  const target = ctx;
  return (task) => {
    target.waitUntil(task);
    return Promise.resolve();
  };
}

/**
 * SSE の 1 つの出来事から使った量を重ねる。message_start で始め、message_delta の合計で上書きする
 * @param found それまでの使った量。message_start の前は null
 * @param block SSE の 1 つの出来事
 * @returns 重ねた使った量
 */
function foldUsage(found: UsageBody | null, block: string): UsageBody | null {
  let next = found;
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = safeJson(line.slice(5).trim());
    const start = MessageStart.safeParse(json);
    if (start.success) next = start.data.message.usage ?? {};
    const delta = MessageDelta.safeParse(json);
    // message_delta の使った量はそれまでの合計なので、値のある項目だけを上書きする
    if (delta.success && delta.data.usage && next) next = { ...next, ...Object.fromEntries(Object.entries(delta.data.usage).filter(([, v]) => v !== null && v !== undefined)) };
  }
  return next;
}

/**
 * 使った量を usage に 1 行足し、自動停止に渡す。失敗しても返事は止めず、ログに残す
 * @param c 要求の文脈
 * @param call 社員、タスク、モデル、要求 ID、待っていた時間
 * @param body 返事の使った量
 */
async function recordUsage(c: Context<GateEnv>, call: Call, body: UsageBody): Promise<void> {
  const env = c.env;
  const at = c.var.clock.now();
  const u = toUsage(body);
  try {
    const { scope } = await findNode(env.DB, call.nodeId);
    await drizzle(recordsOf(env, at))
      .insert(usage)
      .values({
        id: newId(clockAt(at)),
        at,
        staffId: call.staffId,
        nodeId: call.nodeId,
        scope,
        model: call.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costMicroUsd: costMicroUsd(call.model, u),
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
 * 返事の使った量を、足りない項目を 0 にして直す。書き込みは 5 分と 1 時間の合計で、1 時間の分を別に持つ
 * @param body 返事の使った量
 * @returns 使った量
 */
function toUsage(body: UsageBody): ClaudeUsage {
  return {
    inputTokens: body.input_tokens ?? 0,
    outputTokens: body.output_tokens ?? 0,
    cacheReadTokens: body.cache_read_input_tokens ?? 0,
    cacheWriteTokens: body.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: body.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}
