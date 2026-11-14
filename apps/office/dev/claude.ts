// 開発環境の代わりの Claude API。テストが積んだ返事を順に返し、届いた要求を残す
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/** 積む返事。省いた項目は決まった値で埋める */
export type ScriptedMessage = {
  /** 返す中身のブロック */
  content: Record<string, unknown>[];
  /** 止まった理由。初期値は end_turn */
  stop_reason?: string;
  /** 使った量。初期値は入力 10、出力 10 */
  usage?: Record<string, number>;
};

/** 代わりの Claude API */
export type FakeClaude = {
  /** `/v1/messages` と `/__fake/` を持つ Hono */
  app: Hono;
  /** 届いた要求の本文 */
  requests: Record<string, unknown>[];
  /** 返事を積む */
  push(message: ScriptedMessage): void;
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
  const queue: ScriptedMessage[] = [];
  const requests: Record<string, unknown>[] = [];

  const app = new Hono()
    .post("/v1/messages", async (c) => {
      if (!c.req.header("x-api-key")) {
        return c.json({ type: "error", error: { type: "authentication_error", message: "x-api-key が無い" } }, 401);
      }
      const body = await c.req.json<Record<string, unknown>>();
      requests.push(body);
      const next = queue.shift();
      if (!next) {
        return c.json({ type: "error", error: { type: "api_error", message: "代わりの Claude API に返事が積まれていない" } }, 500);
      }
      const message = toMessage(next, body["model"], requests.length);
      if (body["stream"] !== true) return c.json(message);
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
      queue.push(await c.req.json<ScriptedMessage>());
      return c.body(null, 204);
    })
    .get("/__fake/requests", (c) => c.json(requests));

  return { app, requests, push: (message) => queue.push(message) };
}
