// 外の AI が MCP でつなぐ鍵と、MCP の JSON-RPC の形 (ログインと記録の 3.10)
import { MCP_SCOPES } from "../master/mcp-scope.ts";
import { masterSchema } from "../master/master.ts";
import { DecisionInput, NodeStatus } from "./work.ts";
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** 鍵でできる事。read は読むだけ、write は承認と社員への発言も */
export const McpScope = masterSchema(MCP_SCOPES).meta({ description: "read は読むだけ、write は承認と社員への発言もできる" });

/** 鍵でできる事の型 */
export type McpScope = z.infer<typeof McpScope>;

/** MCP の連携 1 件。鍵そのものは返さない */
export const McpClient = z
  .object({
    id: z.uuid().meta({ description: "UUID v7" }),
    name: z.string(),
    scope: McpScope,
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .meta({ id: "McpClient" });

/** MCP の連携の型 */
export type McpClient = z.infer<typeof McpClient>;

/** MCP の連携を作る入力 */
export const CreateMcpClientInput = z
  .object({
    name: z.string().trim().min(1).max(40).meta({ description: "つなぐ先の名前。画面の一覧に出す" }),
    scope: McpScope,
  })
  .strict()
  .meta({ id: "CreateMcpClientInput" });

/** MCP の連携を作る入力の型 */
export type CreateMcpClientInput = z.infer<typeof CreateMcpClientInput>;

/** 作った MCP の連携と鍵。鍵はこの 1 度だけ返す */
export const CreatedMcpClient = z
  .object({
    client: McpClient,
    token: z.string().meta({ description: "MCP の Authorization: Bearer に付ける鍵。この 1 度だけ返し、サーバーは SHA-256 だけを持つ" }),
  })
  .strict()
  .meta({ id: "CreatedMcpClient" });

/** 作った MCP の連携と鍵の型 */
export type CreatedMcpClient = z.infer<typeof CreatedMcpClient>;

/** MCP の JSON-RPC の要求 1 件。id の無い物は通知 */
// MCP 2025-06-18 の Basic の JSON-RPC。1 つの POST に 1 件だけを受ける
export const McpRequest = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().int()]).optional(),
    method: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .meta({ id: "McpRequest" });

/** MCP の JSON-RPC の要求の型 */
export type McpRequest = z.infer<typeof McpRequest>;

/** MCP の JSON-RPC の返事 1 件 */
export const McpResponse = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().int()]).nullable(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ code: z.number().int(), message: z.string() }).strict().optional(),
  })
  .strict()
  .meta({ id: "McpResponse" });

/** MCP の JSON-RPC の返事の型 */
export type McpResponse = z.infer<typeof McpResponse>;

/** MCP の道具の引数が無い時の形 */
export const McpNoArgs = z.object({}).strict();

/** list_tasks の引数。状態か担当の社員で絞る */
export const McpTaskArgs = z.object({ status: NodeStatus.optional(), assignee: StaffId.optional() }).strict();

/** decide_approval の引数。承認の ID と、画面と同じ決定の入力 */
export const McpDecideArgs = z.object({ approvalId: z.uuid() }).extend(DecisionInput.shape).strict();

/** send_message の引数。字数は画面と同じルートが確かめる */
export const McpMessageArgs = z.object({ staffId: StaffId, body: z.string().min(1) }).strict();
