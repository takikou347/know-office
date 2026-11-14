// タスクの木、組織図、オーナーの承認の返す形と入力 (タスクとレビューの 1 章と 2 章、データの 2.2 と 2.5)
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

const Uuid = z.uuid().openapi({ description: "UUID v7" });
const Scope = z.string().min(1).openapi({ description: "`office` またはサービスの ID" });
const StaffParam = StaffId.openapi({ description: "社員 ID。役割ごとに固定" });
const Entries = z.record(z.string(), z.unknown()).openapi({ additionalProperties: true });

/** 木の階層。上から目的、目標、プロジェクト、タスク */
export const NodeKind = z.enum(["purpose", "goal", "project", "task"]);

/** 木の階層の型 */
export type NodeKind = z.infer<typeof NodeKind>;

/** タスクの種類。作る、コンテンツ、直す、社長が分ける、レビュー担当が確かめる */
export const TaskKind = z.enum(["build", "content", "fix", "plan", "review"]);

/** タスクの種類の型 */
export type TaskKind = z.infer<typeof TaskKind>;

/** 木の 1 件の状態 */
export const NodeStatus = z.enum(["todo", "doing", "review", "done", "stopped", "waiting_owner", "dropped"]);

/** 木の 1 件の状態の型 */
export type NodeStatus = z.infer<typeof NodeStatus>;

/** 木の 1 件。progress は配下のタスクのうち済んだ割合で、タスクは済めば 1 */
export const Node = z
  .object({
    id: Uuid,
    kind: NodeKind,
    parentId: z.string().nullable(),
    scope: z.string().openapi({ description: "`office` またはサービスの ID" }),
    title: z.string(),
    body: z.string(),
    taskKind: TaskKind.nullable(),
    assignee: z.string().nullable(),
    status: NodeStatus,
    priority: z.number().int(),
    progress: z.number().min(0).max(1),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "Node" });

/** 木の 1 件の型 */
export type Node = z.infer<typeof Node>;

/** 子を持つ木の 1 件の型 */
export type NodeTree = Node & { children: NodeTree[] };

/** 子を持つ木の 1 件。返す形を書くだけで、受けた物を確かめるのには使わない */
export const NodeTree: z.ZodType<NodeTree> = z
  .intersection(
    Node,
    z
      .object({
        get children() {
          return z.array(NodeTree);
        },
      })
      .strict(),
  )
  .meta({ id: "NodeTree" });

/** タスクの出来事 1 件 */
export const NodeEvent = z
  .object({ at: z.iso.datetime(), staffId: z.string().nullable(), kind: z.string(), detail: Entries })
  .strict();

/** タスクの出来事 1 件の型 */
export type NodeEvent = z.infer<typeof NodeEvent>;

/** タスクの詳細。ancestors は目的からすぐ上の親までの順 */
export const NodeDetail = z
  .intersection(Node, z.object({ ancestors: z.array(Node), events: z.array(NodeEvent) }).strict())
  .meta({ id: "NodeDetail" });

/** タスクの詳細の型 */
export type NodeDetail = z.infer<typeof NodeDetail>;

/** 目的、目標、プロジェクト、タスクを作る入力。taskKind、assignee、priority はタスクだけが持つ */
export const CreateNodeInput = z
  .object({
    kind: NodeKind,
    parentId: Uuid.optional(),
    scope: Scope,
    title: z.string().min(1).max(200),
    body: z.string().max(20_000).optional(),
    taskKind: z.enum(["build", "content", "fix"]).optional(),
    assignee: StaffParam.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .meta({ id: "CreateNodeInput" });

/** 作る入力の型 */
export type CreateNodeInput = z.infer<typeof CreateNodeInput>;

/** 分割 (親の付け替え)、担当、見送りの入力。version は取得した時点のバージョン */
export const UpdateNodeInput = z
  .object({
    version: z.number().int().openapi({ description: "取得した時点のバージョン。現在と異なる場合は 409 conflict" }),
    parentId: Uuid.optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(20_000).optional(),
    assignee: StaffParam.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    status: z.enum(["todo", "dropped"]).optional(),
  })
  .strict()
  .meta({ id: "UpdateNodeInput" });

/** 変える入力の型 */
export type UpdateNodeInput = z.infer<typeof UpdateNodeInput>;

/** 組織図の 1 人。prompt は今の役目の説明文 */
export const OrgStaff = z
  .object({
    id: StaffParam,
    role: z.string(),
    bossId: z.string().nullable(),
    model: z.string(),
    prompt: z.string(),
    promptVersion: z.number().int(),
  })
  .strict()
  .meta({ id: "OrgStaff" });

/** 組織図の 1 人の型 */
export type OrgStaff = z.infer<typeof OrgStaff>;

/** 役目の説明文を変える入力 */
export const UpdatePromptInput = z
  .object({
    version: z.number().int().openapi({ description: "取得した時点のバージョン。現在と異なる場合は 409 conflict" }),
    body: z.string().min(1).max(20_000),
  })
  .strict()
  .meta({ id: "UpdatePromptInput" });

/** 役目の説明文のバージョン */
export const PromptVersion = z.object({ version: z.number().int() }).strict().meta({ id: "PromptVersion" });

/** オーナーの承認の種類 */
export const ApprovalKind = z.enum(["staff_add", "role_change", "prompt_rule", "external_integration", "cost_increase", "merge", "deploy", "service_close", "guard_change"]);

/** オーナーの承認の種類の型 */
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/** オーナーの承認の状態 */
export const ApprovalStatus = z.enum(["pending", "approved", "rejected"]);

/** オーナーの承認 1 件。payload の nodeId は答えを待つタスク */
export const Approval = z
  .object({
    id: Uuid,
    kind: ApprovalKind,
    target: z.string(),
    payload: Entries,
    status: ApprovalStatus,
    requestedBy: z.string(),
    requestedAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    reason: z.string().nullable(),
  })
  .strict()
  .meta({ id: "Approval" });

/** オーナーの承認 1 件の型 */
export type Approval = z.infer<typeof Approval>;

/** 承認か差し戻しの入力 */
export const DecisionInput = z
  .object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(2000) })
  .strict()
  .meta({ id: "DecisionInput" });

/** 社員のツールの答え。content は社員に返す文 */
export const ToolResult = z.object({ content: z.string(), isError: z.boolean() }).strict().meta({ id: "ToolResult" });

/** 社員のツールの答えの型 */
export type ToolResult = z.infer<typeof ToolResult>;
