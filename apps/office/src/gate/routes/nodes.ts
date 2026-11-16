// タスク: 目的、目標、プロジェクト、タスクの木を読む、作る、変える (API の nodes、タスクとレビューの 3.1)
import { createRoute, z } from "@hono/zod-openapi";
import { CreateNodeInput, Node, NodeDetail, NodeStatus, NodeTree, StaffId, UpdateNodeInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { createdResponse, listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, ok } from "../respond.ts";
import { notifyStaff } from "../work/loop.ts";
import { createNode, loadAssigned, loadDetail, loadTrees, toNode, updateNode } from "../work/nodes.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const NodeParam = z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict();

const listNodesRoute = createRoute({
  method: "get",
  path: "/api/v1/nodes",
  operationId: "listNodes",
  tags: ["nodes"],
  summary: "目的からタスクまでのツリー",
  "x-steps": ["`nodes` をスコープと状態で絞り込み、`parent_id` でツリーにする。`assignee` を付けた時は、その社員のタスクだけを並べる"],
  request: {
    query: listQuery(router).extend({
      rootId: z
        .uuid()
        .optional()
        .openapi({ param: { name: "rootId", in: "query" }, description: "UUID v7" }),
      status: NodeStatus.optional().openapi({ param: { name: "status", in: "query" }, description: "タスクだけを状態で絞る。目的、目標、プロジェクトは絞らない" }),
      scope: z
        .string()
        .min(1)
        .optional()
        .openapi({ param: { name: "scope", in: "query" }, description: "`office` またはサービスの ID" }),
      assignee: StaffId.optional().openapi({ param: { name: "assignee", in: "query" }, description: "社員 ID。付けた時は、その社員のタスクだけを木にせず ID の順に並べる (children は空)" }),
    }),
  },
  responses: { 200: listResponse(NodeTree), ...problems(400, 401, 403, 422, 429, 500) },
});

const createNodeRoute = createRoute({
  method: "post",
  path: "/api/v1/nodes",
  operationId: "createNode",
  tags: ["nodes"],
  summary: "目的、目標、タスクを作成する",
  "x-steps": [
    "親が存在し、目的、目標、プロジェクト、タスクの階層の順に合うことを確認する。種類、担当、優先度を持てるのはタスクだけ",
    "`nodes` と `node_events` に 1 件ずつ追加する",
    "監査ログに `node.create` を記録する",
    "担当を付けた場合は、勤務時間外なら `StaffDO.call` で呼び出し、勤務中で手が空いていれば次のタスクを取らせる",
  ],
  "x-errors": [
    "404 `not_found`: 親が存在しない",
    "409 `conflict`: 親の種類が階層に合わない",
    "422 `validation_failed`: タスクでない物に種類、担当、優先度、リポジトリを付けた、リポジトリが owner/name の形でない、またはタスクに種類が無い",
  ],
  request: { body: jsonBody(CreateNodeInput) },
  responses: {
    201: createdResponse(Node),
    ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500),
  },
});

const getNodeRoute = createRoute({
  method: "get",
  path: "/api/v1/nodes/{nodeId}",
  operationId: "getNode",
  tags: ["nodes"],
  summary: "タスクの詳細",
  description: "親の階層とイベントの履歴を含む。",
  "x-steps": ["`nodes`、`node_events`、`work_entries` を取得する"],
  "x-errors": ["404 `not_found`: タスクが存在しない"],
  request: { params: NodeParam },
  responses: { 200: okResponse(NodeDetail), ...problems(401, 403, 404, 429, 500) },
});

const updateNodeRoute = createRoute({
  method: "patch",
  path: "/api/v1/nodes/{nodeId}",
  operationId: "updateNode",
  tags: ["nodes"],
  summary: "分割、担当、見送りを変更する",
  "x-steps": [
    "タスクを取得し、`version` が現在と一致することを確認する",
    "親を付け替える時は階層の順に合うことを、担当の割り当てで作成者とレビュー担当が同じモデルにならないことを確認する",
    "`nodes` を更新し、`node_events` に追加する。作業中のタスクの担当と状態は変えない",
    "監査ログに `node.update` を記録する。担当を付けたか `todo` に戻した場合は、勤務時間外なら `StaffDO.call` で呼び出し、勤務中で手が空いていれば次のタスクを取らせる",
  ],
  "x-errors": ["404 `not_found`: タスクが存在しない", "409 `conflict`: バージョンが異なる、同じモデルの組み合わせ、または作業中のタスクの担当か状態を変えようとした"],
  request: { params: NodeParam, body: jsonBody(UpdateNodeInput) },
  responses: { 200: okResponse(Node), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** タスクの木のルート */
export const nodeRoutes = router
  .openapi(listNodesRoute, async (c) => {
    const query = c.req.valid("query");
    const { trees, next } = query.assignee === undefined ? await loadTrees(c.env.DB, query) : await loadAssigned(c.env.DB, { ...query, assignee: query.assignee });
    return list(c, trees, next);
  })
  .openapi(createNodeRoute, async (c) => {
    const now = c.var.clock.now();
    const row = await createNode(c.env, c.req.valid("json"), { by: "owner", now, traceId: c.var.traceId });
    // オーナーが頼んだタスクは、勤務時間外の社員を呼び出してでも進める
    if (row.assignee !== null) await notifyStaff(c.env, row.assignee, now, true, c.var.traceId);
    return created(c, toNode(row, 0), `/api/v1/nodes/${row.id}`);
  })
  .openapi(getNodeRoute, async (c) => {
    const { node, ancestors, events } = await loadDetail(c.env, c.req.valid("param").nodeId);
    return ok(c, { ...node, ancestors, events });
  })
  .openapi(updateNodeRoute, async (c) => {
    const { version, ...change } = c.req.valid("json");
    const now = c.var.clock.now();
    const row = await updateNode(c.env, c.req.valid("param").nodeId, version, change, { by: "owner", now, traceId: c.var.traceId });
    if (row.assignee !== null && (change.assignee !== undefined || change.status === "todo")) await notifyStaff(c.env, row.assignee, now, true, c.var.traceId);
    const { node } = await loadDetail(c.env, row.id);
    return ok(c, node);
  });
