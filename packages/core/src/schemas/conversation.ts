// 会話と配信の形。社員とのメッセージ、配信の作業トークン、LiveDO が画面に流す出来事 (社員と自動の 3.7、ルートの一覧の 1.6)
import { StaffId, StaffState } from "./workday.ts";
import { z } from "./zod.ts";

/** D1 の messages.body に置く字数の上限。超える本文は R2 に置く (データの 2.4) */
export const MESSAGE_INLINE_CHARS = 2000;

/** 送れる本文の字数の上限 */
export const MESSAGE_MAX_CHARS = 20_000;

/**
 * 文字列のコードポイントの数を返す
 * @param text 文字列
 * @returns コードポイントの数
 */
export function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/**
 * 頭からコードポイントで数えて切る
 * @param text 文字列
 * @param max 字数
 * @returns 頭の max 字
 */
export function headChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/** 社員とのメッセージ 1 件 */
export const Message = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    at: z.iso.datetime(),
    staffId: StaffId,
    nodeId: z.string().nullable(),
    sender: z.enum(["owner", "staff"]),
    body: z.string(),
  })
  .strict()
  .meta({ id: "Message" });

/** 社員とのメッセージ 1 件の型 */
export type Message = z.infer<typeof Message>;

/** 社員にメッセージを送る入力 */
export const CreateMessageInput = z
  .object({
    // 字数はコードポイントで数える。JSON Schema の maxLength と同じ数え方で、絵文字 1 つを 1 字にする
    body: z
      .string()
      .refine((v) => codePoints(v) >= 1 && codePoints(v) <= MESSAGE_MAX_CHARS, { message: `1 字から ${String(MESSAGE_MAX_CHARS)} 字まで` })
      .openapi({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
    nodeId: z.uuid().optional().openapi({ description: "UUID v7" }),
  })
  .strict()
  .meta({ id: "CreateMessageInput" });

/** 社員にメッセージを送る入力の型 */
export type CreateMessageInput = z.infer<typeof CreateMessageInput>;

/** 配信の WebSocket を開く、60 秒のうちに 1 回だけ使える作業トークン */
export const LiveTicket = z.object({ ticket: z.string(), expiresAt: z.iso.datetime() }).strict().meta({ id: "LiveTicket" });

/** 配信の作業トークンの型 */
export type LiveTicket = z.infer<typeof LiveTicket>;

/**
 * LiveDO が画面に流す出来事。社員の状態が変わった、通知が足された、タスクの木の 1 件が変わった (この 2 つは印だけで、画面が GET で読む)、発言が足された。
 * 発言の本文は頭の 2,000 字までで、切った時は truncated にし、画面が GET で読み直す。オーナーの情報、鍵、作業トークンは載せない
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("staff"), staff: z.object({ id: StaffId, state: StaffState, nodeId: z.string().nullable() }).strict() }).strict(),
  z.object({ type: z.literal("notice"), notice: z.object({ id: z.uuid() }).strict() }).strict(),
  z.object({ type: z.literal("node"), node: z.object({ id: z.uuid() }).strict() }).strict(),
  z
    .object({
      type: z.literal("message"),
      message: z.object({ id: z.uuid(), at: z.iso.datetime(), staffId: StaffId, nodeId: z.string().nullable(), sender: z.enum(["owner", "staff"]), body: z.string(), truncated: z.boolean() }).strict(),
    })
    .strict(),
]);

/** LiveDO が画面に流す出来事の型 */
export type LiveEvent = z.infer<typeof LiveEvent>;
