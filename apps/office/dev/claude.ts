// 開発環境の代わりの Claude API。テストが積んだ返事と上限の失敗を順に返し、届いた要求と鍵を残す
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

/** 積んだ失敗。上限 (429) と混み合い (529) を Anthropic の形で返す */
type ScriptedError = { error: { status: 429 | 529 | 500; type: string } };

const MessagesRequest = z.looseObject({ model: z.string().optional(), stream: z.boolean().optional() });

/** 代わりの Claude API */
export type FakeClaude = {
  /** `/v1/messages` と `/__fake/` を持つ Hono */
  app: Hono;
  /** 届いた要求の本文 */
  requests: z.infer<typeof MessagesRequest>[];
  /** 届いた x-api-key。プロキシが鍵を替えた事を確かめる */
  keys: string[];
  /** 返事を積む */
  push(message: ScriptedMessage): void;
  /** 失敗を積む */
  pushError(status: 429 | 529 | 500, type: string): void;
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

/**
 * 代わりの Claude API を作る
 * @returns Hono、届いた要求、返事を積む push
 */
export function createFakeClaude(): FakeClaude {
  const queue: (ScriptedMessage | ScriptedError)[] = [];
  const requests: z.infer<typeof MessagesRequest>[] = [];
  const keys: string[] = [];

  const app = new Hono()
    .use("/v1/*", async (c, next) => {
      const key = c.req.header("x-api-key");
      if (!key) return c.json({ type: "error", error: { type: "authentication_error", message: "x-api-key が無い" } }, 401);
      keys.push(key);
      return next();
    })
    // 数えるだけの呼び出しは積んだ返事を使わず、本文の長さから決まった数を返す
    .post("/v1/messages/count_tokens", async (c) => c.json({ input_tokens: Math.ceil((await c.req.text()).length / 4) }))
    .post("/v1/messages", async (c) => {
      const body = MessagesRequest.parse(await c.req.json());
      requests.push(body);
      const next = queue.shift();
      if (!next) {
        return c.json({ type: "error", error: { type: "api_error", message: "代わりの Claude API に返事が積まれていない" } }, 500);
      }
      if ("error" in next) {
        return new Response(JSON.stringify({ type: "error", error: { type: next.error.type, message: "代わりの Claude API が積んだ失敗" } }), {
          status: next.error.status,
          headers: { "content-type": "application/json" },
        });
      }
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
      queue.push(ScriptedMessage.parse(await c.req.json()));
      return c.body(null, 204);
    })
    .get("/__fake/requests", (c) => c.json(requests));

  return {
    app,
    requests,
    keys,
    push: (message) => queue.push(message),
    pushError: (status, type) => queue.push({ error: { status, type } }),
  };
}
