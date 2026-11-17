// 会話と配信の形。社員とのメッセージ、配信の作業トークン、LiveDO が画面に流す出来事 (社員と自動の 3.7、API の conversation)
import { jstClock, jstDay } from "../time.ts";
import { StaffId, StaffState } from "./workday.ts";
import { z } from "./zod.ts";

/** D1 の messages.body に置く字数の上限。超える本文は R2 に置く (データの 2 章) */
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

/** オーナーの発言を社員に渡した道。run は今の呼び出し、next_task は次の呼び出しの頭、skipped は渡す枠の外で渡していない */
export const MessageDelivery = z.enum(["run", "next_task", "skipped"]);

/** オーナーの発言を社員に渡した道の型 */
export type MessageDelivery = z.infer<typeof MessageDelivery>;

/** 社員とのメッセージ 1 件 */
export const Message = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    at: z.iso.datetime(),
    staffId: StaffId.meta({ description: "社員 ID。役割ごとに固定" }),
    nodeId: z.string().nullable(),
    sender: z.enum(["owner", "staff"]),
    body: z.string(),
    deliveredAt: z.iso.datetime().nullable().openapi({ description: "社員のワークスペースが発言を受けた時刻。まだ渡していないか、社員の発言なら null" }),
    delivery: MessageDelivery.nullable().openapi({ description: "渡した道。まだ渡していないオーナーの発言と社員の発言は null" }),
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

/** オフィスで見せる仕事の出来事の種類。渡す、レビューを頼む、承認、差し戻し */
export const OFFICE_WORK_ACTIONS = ["assign", "review-request", "approve", "send-back"] as const;

/** オフィスで見せる仕事の出来事。社員でない側 (オーナー、ゲートウェイ) は owner にする */
export const OfficeWork = z
  .object({
    nodeId: z.uuid(),
    title: z.string().min(1).max(200),
    action: z.enum(OFFICE_WORK_ACTIONS),
    from: z.union([StaffId, z.literal("owner")]),
    to: z.union([StaffId, z.literal("owner")]),
  })
  .strict();

/** オフィスで見せる仕事の出来事の型 */
export type OfficeWork = z.infer<typeof OfficeWork>;

/**
 * LiveDO が画面に流す出来事。社員の状態が変わった、通知が足された、タスクの木の 1 件が変わった (この 2 つは印だけで、画面が GET で読む)、発言が足された、オーナーの発言を社員に渡した (ID と道と時刻だけ)、
 * オフィスで見せる仕事の出来事 (渡した、レビューを頼んだ、承認した、差し戻した) が起きた。
 * 発言の本文は頭の 2,000 字までで、切った時は truncated にし、画面が GET で読み直す。仕事の出来事はタスクの題と誰から誰へだけを持つ。オーナーの情報、鍵、作業トークンは載せない
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("staff"), staff: z.object({ id: StaffId, state: StaffState, nodeId: z.string().nullable() }).strict() }).strict(),
  z.object({ type: z.literal("notice"), notice: z.object({ id: z.uuid() }).strict() }).strict(),
  z.object({ type: z.literal("node"), node: z.object({ id: z.uuid() }).strict() }).strict(),
  z.object({ type: z.literal("work"), work: OfficeWork }).strict(),
  z
    .object({
      type: z.literal("message_delivered"),
      delivery: z.object({ id: z.uuid(), via: MessageDelivery, at: z.iso.datetime() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("message"),
      message: z.object({ id: z.uuid(), at: z.iso.datetime(), staffId: StaffId, nodeId: z.string().nullable(), sender: z.enum(["owner", "staff"]), body: z.string(), truncated: z.boolean() }).strict(),
    })
    .strict(),
]);

/** LiveDO が画面に流す出来事の型 */
export type LiveEvent = z.infer<typeof LiveEvent>;

/** 社員に渡すオーナーの発言 1 件 */
export type OwnerMessage = {
  /** 受けた時刻。協定世界時のミリ秒 */
  at: number;
  /** 本文 */
  body: string;
  /** 本文を頭で切ったか */
  truncated?: boolean;
};

/**
 * オーナーの発言を、社員への指示に足す形にする。本文は JSON の文字列にし、本文の中の改行や見出しで区切りを偽らせない
 * @param messages 古い順の発言
 * @returns 1 件 1 行の指示
 */
export function ownerMessagesPrompt(messages: readonly OwnerMessage[]): string {
  return messages
    .map((m) => `オーナーの発言 (日本時間 ${jstDay(m.at)} ${jstClock(m.at)}): ${JSON.stringify(m.body)}${m.truncated === true ? ` (頭の ${MESSAGE_INLINE_CHARS.toLocaleString("en-US")} 字まで。続きは会話の画面にある)` : ""}`)
    .join("\n");
}
