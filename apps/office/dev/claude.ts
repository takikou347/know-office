// 開発環境の代わりの Claude API。テストが積んだ返事と上限の失敗を順に返し、使用の上限に切り替えられ、届いた要求と鍵を残す。バッチ処理は受けた後にテストが終えさせる
import { DEV_STAFF_HEADER, SPEND_LIMIT_KINDS, type SpendLimitKind, StaffId } from "@know-office/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

/** 積む返事。content は返す中身のブロック、stop_reason の初期値は end_turn、usage の初期値は入力 10、出力 10 */
export const ScriptedMessage = z.object({
  content: z.array(z.record(z.string(), z.unknown())),
  stop_reason: z.string().optional(),
  usage: z.record(z.string(), z.number()).optional(),
});

/** 積む返事の型 */
export type ScriptedMessage = z.infer<typeof ScriptedMessage>;

/**
 * 外から積む返事。staffId を付けると、その社員の作業トークンの呼び出しにだけ返す。同じ時に動くほかの社員の SDK に取られないようにする
 * delay_ms を付けると、積んでからその間が過ぎるまで返さずに待つ。待つ間に呼び出しが切れたら返さず、積んだ物の先頭に戻す。SDK が待ち切れずに呼び直しても、積んだ時から数えるので待ちは延びない (勤務の終わりの時刻を過ぎるまで社員を作業の途中に置く通しに使う)
 */
const ScriptedInput = ScriptedMessage.extend({ staffId: StaffId.optional(), delay_ms: z.number().int().min(0).max(600_000).optional() });

/** 積んだ返事か失敗と、渡す社員と返してよい時刻。staffId が null ならどの呼び出しにも渡す */
type Queued = { item: ScriptedMessage | ScriptedError; staffId: StaffId | null; notBefore?: number };

/**
 * 渡し先を決めずに積んだ物と、その社員に積んだ物のうち、先に積んだ物を取り出す
 * @param queue 積んだ物
 * @param staffId 呼び出しの社員
 * @returns 取り出した物。無ければ undefined
 */
function takeQueued(queue: Queued[], staffId: StaffId | null): Queued | undefined {
  const at = queue.findIndex((q) => q.staffId === null || q.staffId === staffId);
  return at === -1 ? undefined : queue.splice(at, 1)[0];
}

/** 待ちを付けた返事を待っている呼び出し。同じ社員の呼び直しが来たら supersede で捨てる */
type Waiter = { queued: Queued; model: string | undefined; superseded: boolean; supersede: () => void };

/**
 * 待つ。呼び出しが切れたら待つのをやめる
 * @param ms ミリ秒
 * @param signal 呼び出しの signal
 * @returns 待ち終えたら true、切れたら false
 */
function waitUnlessGone(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", gone);
      resolve(true);
    }, ms);
    const gone = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", gone, { once: true });
  });
}

/**
 * 鍵が作業トークン (JWT) なら、その社員 ID (sub) を読む。署名は確かめず、積んだ返事の渡し先を選ぶのにだけ使う
 * @param key x-api-key
 * @returns 社員 ID。作業トークンでなければ null
 */
function staffOfKey(key: string | undefined): StaffId | null {
  const payload = key?.split(".")[1];
  if (key?.split(".").length !== 3 || payload === undefined) return null;
  try {
    const sub: unknown = z.looseObject({ sub: z.unknown() }).parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).sub;
    const staffId = StaffId.safeParse(sub);
    return staffId.success ? staffId.data : null;
  } catch {
    return null;
  }
}

/**
 * 呼び出しの社員を決める。鍵が作業トークンならその社員、ゲートウェイの Claude のプロキシを通って鍵が替わっていれば、プロキシが付けた社員の印を使う
 * @param key x-api-key
 * @param mark DEV_STAFF_HEADER の値
 * @returns 社員 ID。どちらからも決まらなければ null
 */
function staffOfCall(key: string | undefined, mark: string | undefined): StaffId | null {
  const fromKey = staffOfKey(key);
  if (fromKey !== null) return fromKey;
  const fromMark = StaffId.safeParse(mark);
  return fromMark.success ? fromMark.data : null;
}

/** 積める失敗のステータス */
type ErrorStatus = 400 | 401 | 402 | 429 | 500 | 529;

/** 失敗に足す物。message の初期値は決まった文、details は error.details、headers は返事のヘッダー */
export type ErrorExtra = { message?: string; details?: Record<string, string>; headers?: Record<string, string> };

/** 積んだ失敗。鍵の失敗 (401)、上限 (400、402、429)、混み合い (529) を Anthropic の形で返す */
export type ScriptedError = { error: { status: ErrorStatus; type: string } & ErrorExtra };

/** 使用の上限の返事の中身。月の使用の上限の 429 は retry-after を持たない。出典: platform.claude.com/docs/en/api/rate-limits の「Reaching your spend cap」と「Setting your own spend limit」、/docs/en/api/errors の 402 */
const SPEND_LIMIT_ERRORS: Record<SpendLimitKind, ScriptedError["error"]> = {
  organization: { status: 400, type: "invalid_request_error", message: "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." },
  workspace: { status: 400, type: "invalid_request_error", message: "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." },
  monthly: {
    status: 429,
    type: "rate_limit_error",
    message: "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-12-01 at 00:00 UTC.",
    details: { error_code: "enforced_spend_limit_reached" },
  },
  billing: { status: 402, type: "billing_error", message: "There's an issue with your billing or payment information." },
};

/**
 * 使用の上限の返事を、本物と同じ形で作る
 * @param kind 使用の上限の種類
 * @returns 積む失敗
 */
export function spendLimitError(kind: SpendLimitKind): ScriptedError {
  return { error: { ...SPEND_LIMIT_ERRORS[kind] } };
}

/**
 * 積んだ失敗を Anthropic の形の返事にする
 * @param scripted 積んだ失敗
 * @returns 返事
 */
function errorResponse(scripted: ScriptedError): Response {
  const { status, type, message, details, headers } = scripted.error;
  const error = { type, message: message ?? "代わりの Claude API が積んだ失敗", ...(details === undefined ? {} : { details }) };
  return new Response(JSON.stringify({ type: "error", error, request_id: "req_fake_error" }), { status, headers: { "content-type": "application/json", ...headers } });
}

/** 使用の上限に切り替える口の本文。limit が null なら元に戻す */
const LimitInput = z.object({ staffId: StaffId, limit: z.enum(SPEND_LIMIT_KINDS).nullable() }).strict();

const MessagesRequest = z.looseObject({ model: z.string().optional(), stream: z.boolean().optional() });

/** バッチ処理の要求の本文 */
const BatchRequest = z.object({ requests: z.array(z.object({ custom_id: z.string(), params: MessagesRequest })).min(1) });

/** 受けたバッチ処理 */
export type FakeBatch = {
  /** msgbatch_ で始まる ID */
  id: string;
  /** 受けた要求 */
  requests: z.infer<typeof BatchRequest>["requests"];
  /** 終えたら custom_id ごとの答え。errored は失敗として返す */
  answers: Map<string, ScriptedMessage | "errored"> | null;
};

/** 代わりの Claude API */
export type FakeClaude = {
  /** `/v1/messages` と `/__fake/` を持つ Hono */
  app: Hono;
  /** 届いた要求の本文 */
  requests: z.infer<typeof MessagesRequest>[];
  /** 届いた x-api-key。プロキシが鍵を替えた事を確かめる */
  keys: string[];
  /** 通す鍵。Anthropic の画面で作った鍵にあたり、ほかの鍵は本物と同じく 401 で断る */
  accepted: Set<string>;
  /** 返事を積む */
  push(message: ScriptedMessage): void;
  /** 失敗を積む。extra で message、details、ヘッダーを足す */
  pushError(status: ErrorStatus, type: string, extra?: ErrorExtra): void;
  /** 受けたバッチ処理 */
  batches: FakeBatch[];
  /** バッチ処理を終えさせる。answer は custom_id ごとの答えを返す */
  endBatch(id: string, answer: (customId: string) => ScriptedMessage | "errored"): void;
};

/**
 * 積んだ返事を Messages API の形に直す
 * @param message 積んだ返事
 * @param model 要求のモデル
 * @param index 何番目の返事か
 * @returns Messages API の返事
 */
function toMessage(message: ScriptedMessage, model: unknown, index: number) {
  return {
    id: `msg_fake_${String(index)}`,
    type: "message",
    role: "assistant",
    model: typeof model === "string" ? model : "claude-opus-5-5",
    content: message.content,
    stop_reason: message.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10, ...message.usage },
  };
}

/** 代わりの Claude API の作り方 */
export type FakeClaudeOptions = {
  /** 通す鍵 */
  keys: string[];
  /** true なら社員の作業トークン (JWT) も通す。開発のワークスペースはプロキシを通さずに呼ぶ */
  workTokens?: boolean;
};

/** 通す鍵を替える本文。Anthropic の画面で鍵を作る、消す事にあたる */
const KeysInput = z.object({ keys: z.array(z.string().min(1)) });

/**
 * 代わりの Claude API を作る
 * @param options 通す鍵と、作業トークンを通すか
 * @returns Hono、届いた要求、返事を積む push
 */
export function createFakeClaude(options: FakeClaudeOptions): FakeClaude {
  const queue: Queued[] = [];
  const requests: z.infer<typeof MessagesRequest>[] = [];
  const keys: string[] = [];
  const accepted = new Set(options.keys);
  const batches: FakeBatch[] = [];
  // 使用の上限に切り替えた社員。戻すまで、その社員の呼び出しに上限の返事を返し続ける
  const limits = new Map<StaffId, SpendLimitKind>();
  // 待ちを付けた返事を待っている、社員ごとの呼び出し
  const waiting = new Map<StaffId, Waiter>();
  const toBatch = (b: FakeBatch) => {
    const values = b.answers ? [...b.answers.values()] : [];
    return {
      id: b.id,
      type: "message_batch",
      processing_status: b.answers ? "ended" : "in_progress",
      request_counts: {
        processing: b.answers ? 0 : b.requests.length,
        succeeded: values.filter((v) => v !== "errored").length,
        errored: values.filter((v) => v === "errored").length,
        canceled: 0,
        expired: 0,
      },
      results_url: b.answers ? `https://api.anthropic.com/v1/messages/batches/${b.id}/results` : null,
    };
  };

  const app = new Hono()
    .use("/v1/*", async (c, next) => {
      const key = c.req.header("x-api-key");
      if (!key) return c.json({ type: "error", error: { type: "authentication_error", message: "x-api-key が無い" } }, 401);
      keys.push(key);
      // 本物は作っていない鍵と消した鍵を 401 の authentication_error で断る (https://docs.claude.com/en/api/errors)
      if (!accepted.has(key) && !(options.workTokens === true && staffOfKey(key) !== null)) {
        return c.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
      }
      return next();
    })
    .post("/v1/messages/batches", async (c) => {
      const body = BatchRequest.parse(await c.req.json());
      const batch: FakeBatch = { id: `msgbatch_fake${String(batches.length + 1)}`, requests: body.requests, answers: null };
      batches.push(batch);
      return c.json(toBatch(batch));
    })
    .get("/v1/messages/batches/:id", (c) => {
      const batch = batches.find((b) => b.id === c.req.param("id"));
      if (!batch) return c.json({ type: "error", error: { type: "not_found_error", message: "バッチが無い" } }, 404);
      return c.json(toBatch(batch));
    })
    .get("/v1/messages/batches/:id/results", (c) => {
      const batch = batches.find((b) => b.id === c.req.param("id"));
      if (!batch) return c.json({ type: "error", error: { type: "not_found_error", message: "バッチが無い" } }, 404);
      const answers = batch.answers;
      if (!answers) return c.json({ type: "error", error: { type: "invalid_request_error", message: "まだ終わっていない" } }, 400);
      const lines = batch.requests.map((r, i) => {
        const answer = answers.get(r.custom_id) ?? "errored";
        const result =
          answer === "errored"
            ? { type: "errored", error: { type: "error", error: { type: "api_error", message: "代わりの Claude API が積んだ失敗" } } }
            : { type: "succeeded", message: toMessage(answer, r.params.model, i + 1) };
        return JSON.stringify({ custom_id: r.custom_id, result });
      });
      return c.body(`${lines.join("\n")}\n`, 200, { "content-type": "application/binary" });
    })
    // 数えるだけの呼び出しは積んだ返事を使わず、本文の長さから決まった数を返す
    .post("/v1/messages/count_tokens", async (c) => c.json({ input_tokens: Math.ceil((await c.req.text()).length / 4) }))
    .post("/v1/messages", async (c) => {
      const body = MessagesRequest.parse(await c.req.json());
      requests.push(body);
      const staffId = staffOfCall(c.req.header("x-api-key"), c.req.header(DEV_STAFF_HEADER));
      // 本物の使用の上限は、直すまでどの呼び出しも断る
      const limit = staffId === null ? undefined : limits.get(staffId);
      if (limit !== undefined) return errorResponse(spendLimitError(limit));
      // ゲートウェイのプロキシを通ると、SDK が切った呼び出しは切れたと届かない。同じ社員の同じモデルの呼び直しが来たら、待っている前の呼び出しを捨てて、待っていた返事を呼び直しに渡す
      const waiter = staffId === null ? undefined : waiting.get(staffId);
      const taken = waiter?.model === body.model ? waiter : undefined;
      taken?.supersede();
      // 渡し先を決めずに積んだ物と、この社員に積んだ物のうち、先に積んだ物を返す
      const queued = taken ? taken.queued : takeQueued(queue, staffId);
      if (queued?.notBefore !== undefined) {
        const gone = new AbortController();
        const mine: Waiter = { queued, model: body.model, superseded: false, supersede: () => ((mine.superseded = true), gone.abort()) };
        if (staffId !== null) waiting.set(staffId, mine);
        const waited = await waitUnlessGone(Math.max(0, queued.notBefore - Date.now()), AbortSignal.any([c.req.raw.signal, gone.signal]));
        if (staffId !== null && waiting.get(staffId) === mine) waiting.delete(staffId);
        // 呼び直しに渡した返事は戻さない。切れた時だけ積んだ物の先頭に戻す
        if (!waited) {
          if (!mine.superseded) queue.unshift(queued);
          return new Response(null, { status: 499 });
        }
      }
      const next = queued?.item;
      if (!next) {
        return c.json({ type: "error", error: { type: "api_error", message: "代わりの Claude API に返事が積まれていない" } }, 500);
      }
      if ("error" in next) return errorResponse(next);
      const message = toMessage(next, body.model, requests.length);
      if (body.stream !== true) return c.json(message);
      return streamSSE(c, async (stream) => {
        const send = (event: string, data: Record<string, unknown>) => stream.writeSSE({ event, data: JSON.stringify({ type: event, ...data }) });
        await send("message_start", { message: { ...message, content: [], stop_reason: null } });
        for (const [index, block] of message.content.entries()) {
          const { text, input, ...head } = block;
          await send("content_block_start", { index, content_block: { ...head, ...(block["type"] === "text" ? { text: "" } : { input: {} }) } });
          const delta = block["type"] === "text" ? { type: "text_delta", text } : { type: "input_json_delta", partial_json: JSON.stringify(input) };
          await send("content_block_delta", { index, delta });
          await send("content_block_stop", { index });
        }
        await send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
        await send("message_stop", {});
      });
    })
    .post("/__fake/responses", async (c) => {
      const input = ScriptedInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ type: "error", error: { type: "invalid_request_error", message: "積む返事の形が違う" } }, 400);
      const { staffId, delay_ms: delayMs, ...message } = input.data;
      queue.push({ item: message, staffId: staffId ?? null, ...(delayMs === undefined ? {} : { notBefore: Date.now() + delayMs }) });
      return c.body(null, 204);
    })
    // 通しが社員の呼び出しを使用の上限に切り替え、終わりに戻す
    .post("/__fake/limit", async (c) => {
      const input = LimitInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ type: "error", error: { type: "invalid_request_error", message: "切り替えの形が違う" } }, 400);
      if (input.data.limit === null) limits.delete(input.data.staffId);
      else limits.set(input.data.staffId, input.data.limit);
      return c.body(null, 204);
    })
    .get("/__fake/requests", (c) => c.json(requests))
    .get("/__fake/keys", (c) => c.json({ keys: [...accepted] }))
    .put("/__fake/keys", async (c) => {
      const input = KeysInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ type: "error", error: { type: "invalid_request_error", message: "鍵の形が違う" } }, 400);
      accepted.clear();
      for (const key of input.data.keys) accepted.add(key);
      return c.body(null, 204);
    });

  return {
    app,
    requests,
    keys,
    accepted,
    push: (message) => queue.push({ item: message, staffId: null }),
    pushError: (status, type, extra) => queue.push({ item: { error: { status, type, ...extra } }, staffId: null }),
    batches,
    endBatch: (id, answer) => {
      const batch = batches.find((b) => b.id === id);
      if (!batch) throw new Error(`バッチ ${id} が無い`);
      batch.answers = new Map(batch.requests.map((r) => [r.custom_id, answer(r.custom_id)]));
    },
  };
}
