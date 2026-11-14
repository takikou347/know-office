// ワークスペースとゲートウェイ、社員 DO の間でやり取りする形と、作業トークンの中身 (社員が考えるの 1.2、1.3、2 章)
import { fromBase64 } from "../encoding.ts";
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** POST /ws/v1/heartbeat の入力。送った時刻 */
export const HeartbeatInput = z.object({ at: z.iso.datetime() }).strict().meta({ id: "HeartbeatInput" });

/** ハートビートの型 */
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/** POST /v1/runs の入力。タスク 1 件分の SDK の呼び出し */
export const RunInput = z
  .object({
    nodeId: z.uuid(),
    ticket: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high"]),
    systemPrompt: z.string(),
    prompt: z.string(),
    resume: z.string().min(1).optional(),
  })
  .strict()
  .meta({ id: "RunInput" });

/** タスク 1 件分の SDK の呼び出しの型 */
export type RunInput = z.infer<typeof RunInput>;

/** 会話の記録の 1 つの部分の元の長さの上限 (512KiB)。ゲートウェイの本文の上限 1MB に base64 で収める */
export const TRANSCRIPT_PART_BYTES = 512 * 1024;

/**
 * 戻す会話の記録の全部の上限 (12MiB)。社員 DO が戻す時は、部分の並び、つないだ物、base64、JSON の 4 つが
 * 同時にメモリに載るので、合わせて DO のメモリ 128MB の半分に収まる大きさにする
 */
export const RESTORE_TRANSCRIPT_BYTES = 12 * 1024 * 1024;

/** ワークスペースの /v1/restore が受ける本文の上限。上限ちょうどの記録の base64 に、JSON の枠の分 1KiB を足す */
export const RESTORE_BODY_BYTES = Math.ceil(RESTORE_TRANSCRIPT_BYTES / 3) * 4 + 1024;

/** base64 の文字列。長い物も正規表現の戻りで投げないよう、fromBase64 で確かめる */
const Base64Text = z
  .string()
  .refine((text) => fromBase64(text) !== null, { message: "base64 でない" })
  .meta({ contentEncoding: "base64" });

/** SDK の会話の session。R2 の置き場とワークスペースのファイルの名前に入るので、UUID だけを受ける */
const SessionId = z.uuid();

/** POST /ws/v1/transcript-parts の入力。会話の記録 (JSONL) の増えた分 */
export const TranscriptPartInput = z
  .object({
    sessionId: SessionId,
    seq: z.int().nonnegative(),
    chunk: Base64Text.min(1).max(Math.ceil(TRANSCRIPT_PART_BYTES / 3) * 4),
  })
  .strict()
  .meta({ id: "TranscriptPartInput" });

/** 会話の記録の部分の型 */
export type TranscriptPartInput = z.infer<typeof TranscriptPartInput>;

/** POST /v1/restore の入力。復号した会話の記録の全部と、次に送る部分の通し番号 */
export const RestoreInput = z
  .object({
    sessionId: SessionId,
    transcript: Base64Text,
    nextSeq: z.int().nonnegative(),
  })
  .strict()
  .meta({ id: "RestoreInput" });

/** 会話の記録の復元の型 */
export type RestoreInput = z.infer<typeof RestoreInput>;

/** PUT /v1/ticket の入力。差し替える作業トークン */
export const TicketInput = z.object({ ticket: z.string().min(1) }).strict().meta({ id: "TicketInput" });

/** 作業トークンの差し替えの型 */
export type TicketInput = z.infer<typeof TicketInput>;

/** 作業トークン (HS256 の JWT) の中身。sub は社員、node はタスク、ws は発行した先のワークスペース、時刻は秒 */
export const WorkTicketClaims = z
  .object({
    sub: StaffId,
    node: z.uuid(),
    ws: z.string().min(1),
    jti: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

/** 作業トークンの中身の型 */
export type WorkTicketClaims = z.infer<typeof WorkTicketClaims>;
