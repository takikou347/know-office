// ワークスペースとゲートウェイ、社員 DO の間でやり取りする形と、作業トークンの中身 (社員が考えるの 1.2、1.3、2 章)
import { fromBase64 } from "../encoding.ts";
import { STAFF_TOOL_NAMES } from "../rules/staff-tools.ts";
import { StaffId, WorkResult } from "./workday.ts";
import { z } from "./zod.ts";

/** POST /ws/v1/heartbeat の入力。送った時刻 */
export const HeartbeatInput = z.object({ at: z.iso.datetime() }).strict().meta({ id: "HeartbeatInput" });

/** ハートビートの型 */
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/** ワークスペースに渡す拡張のツールの数の上限 */
export const EXTENSION_TOOLS_MAX = 32;

/** ゲートウェイでの拡張のツールの名前。`ext__<拡張 ID>__<ツール>` で、形は EXTENSION_ID と EXTENSION_TOOL と同じ */
export const EXTENSION_TOOL_NAME = /^ext__[a-z][a-z\d]*(?:-[a-z\d]+)*__[a-z][a-z\d]*(?:_[a-z\d]+)*$/;

/** 入れた拡張のツール 1 つ。ワークスペースは inputSchema (JSON Schema) から入力の形を作り、MCP の受け手 staff に足す */
export const ExtensionToolSpec = z
  .object({
    name: z.string().max(128).regex(EXTENSION_TOOL_NAME),
    description: z.string().min(1).max(1000),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict()
  .meta({ id: "ExtensionToolSpec", description: "入れた拡張のツール 1 つ。ワークスペースは inputSchema (JSON Schema) から入力の形を作る" });

/** 入れた拡張のツール 1 つの型 */
export type ExtensionToolSpec = z.infer<typeof ExtensionToolSpec>;

/**
 * 拡張のツールの入力の JSON Schema から、SDK のツールに渡す入力の形を作る
 * @param inputSchema 入力の JSON Schema
 * @returns 項目ごとの Zod スキーマ。オブジェクトの形でない時と読めない時は null
 */
export function extensionToolShape(inputSchema: Record<string, unknown>): Record<string, z.ZodType> | null {
  try {
    const schema = z.fromJSONSchema(inputSchema);
    return schema instanceof z.ZodObject ? schema.shape : null;
  } catch {
    return null;
  }
}

/** POST /v1/runs の入力。タスク 1 件分の SDK の呼び出し */
export const RunInput = z
  .object({
    nodeId: z.uuid().meta({ description: "UUID v7" }),
    ticket: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high"]),
    systemPrompt: z.string(),
    prompt: z.string(),
    resume: z.string().min(1).optional(),
    // 社員の役で使える社員のツール。ワークスペースはこの名前のツールだけを MCP の受け手 staff に出す
    tools: z.array(z.enum(STAFF_TOOL_NAMES)).max(STAFF_TOOL_NAMES.length).meta({ description: "社員の役で使える社員のツール。ワークスペースはこの名前のツールだけを MCP の受け手 staff に出す" }),
    // 入れている拡張のツール。ワークスペースは役のツールと同じ受け手 staff に足し、どれもゲートウェイの同じ口を呼ぶ
    extensionTools: z.array(ExtensionToolSpec).max(EXTENSION_TOOLS_MAX).optional().meta({ description: "入れている拡張のツール。ワークスペースは役のツールと同じ受け手 staff に足し、どれもゲートウェイの同じ口を呼ぶ" }),
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
    sessionId: SessionId.meta({ description: "SDK の会話の session" }),
    seq: z.int().nonnegative().meta({ description: "session ごとの通し番号。0 から始め、前回の続きにする。返事が届かずに前回と同じ通し番号を送り直した時は、中身が同じなら 204 で受け直して何も足さず、違えば 409 で断る" }),
    chunk: Base64Text.min(1).max(Math.ceil(TRANSCRIPT_PART_BYTES / 3) * 4).meta({ description: "会話の記録 (JSONL) の増えた分。元の長さは 512KiB まで" }),
  })
  .strict()
  .meta({ id: "TranscriptPartInput" });

/** 会話の記録の部分の型 */
export type TranscriptPartInput = z.infer<typeof TranscriptPartInput>;

/** POST /v1/restore の入力。復号した会話の記録の全部と、次に送る部分の通し番号 */
export const RestoreInput = z
  .object({
    sessionId: SessionId.meta({ description: "続きから呼ぶ SDK の会話の session" }),
    transcript: Base64Text.meta({ description: "復号した会話の記録 (JSONL) の全部" }),
    nextSeq: z.int().nonnegative().meta({ description: "次に送る部分の通し番号" }),
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
    // 呼び出しを始めた要求の traceId。ゲートウェイはワークスペースからの要求をこの traceId で記録する
    trc: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  })
  .strict();

/** 作業トークンの中身の型 */
export type WorkTicketClaims = z.infer<typeof WorkTicketClaims>;

/** POST /ws/v1/events で 1 回に送る出来事の上限 */
export const AGENT_EVENTS_MAX = 50;

/** ワークスペースが送れるエラーの名前。sdk_auth_failed は Claude の鍵が断られた、sdk_failed はほかの SDK の失敗。ほかの名前は断り、エラーログに好きな文を書かせない */
export const AGENT_ERROR_NAMES = z.enum(["sdk_auth_failed", "sdk_failed"]);

/** ワークスペースから届く出来事の 1 つ。発言、ツールの結果、チェックポイント、エラー、終わり */
export const AgentEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), body: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("tool_result"), toolName: z.string().max(200), command: z.string().max(2000), exitCode: z.int(), failedChecks: z.array(z.string().max(100)).max(20) }).strict(),
  z.object({ kind: z.literal("checkpoint"), nodeId: z.uuid().meta({ description: "UUID v7" }), checkpoint: z.enum(["test_pass", "commit", "pr", "note"]), note: z.string().max(2000).optional() }).strict(),
  z.object({ kind: z.literal("error"), name: AGENT_ERROR_NAMES, message: z.string().max(200) }).strict(),
  z.object({ kind: z.literal("result"), nodeId: z.uuid().meta({ description: "UUID v7" }), result: WorkResult }).strict(),
]).openapi({ discriminator: { propertyName: "kind" } });

/** ワークスペースから届く出来事の型 */
export type AgentEvent = z.infer<typeof AgentEvent>;

/** POST /ws/v1/events の入力 */
export const AgentEventsInput = z.object({ events: z.array(AgentEvent).min(1).max(AGENT_EVENTS_MAX) }).strict().meta({ id: "AgentEventsInput" });

/** ワークスペースから届く出来事の並びの型 */
export type AgentEventsInput = z.infer<typeof AgentEventsInput>;

/** POST /v1/messages の入力。走っている呼び出しに足すオーナーの発言 */
export const WorkspaceMessageInput = z.object({ body: z.string().min(1).max(20_000) }).strict().meta({ id: "WorkspaceMessageInput" });

/** オーナーの発言の型 */
export type WorkspaceMessageInput = z.infer<typeof WorkspaceMessageInput>;

/** 理由だけを持つ入力。POST /v1/abort などが受ける */
export const ReasonInput = z.object({ reason: z.string() }).strict().meta({ id: "ReasonInput" });

/** 理由だけを持つ入力の型 */
export type ReasonInput = z.infer<typeof ReasonInput>;
