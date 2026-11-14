// タスク: 目的、目標、プロジェクト、タスクの木を読む、作る、変える (ルートの一覧の 1.7、タスクとレビューの 3.1)
import { createRoute, z } from "@hono/zod-openapi";
import { CreateNodeInput, Node, NodeDetail, NodeStatus, NodeTree, UpdateNodeInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, ok } from "../respond.ts";
import { notifyStaff } from "../work/loop.ts";
import { createNode, loadDetail, loadTrees, toNode, updateNode } from "../work/nodes.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const NodeParam = z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict();

const listNodesRoute = createRoute({
  method: "get",
  path: "/api/v1/nodes",
  operationId: "listNodes",
  tags: ["nodes"],
  request: {
    query: listQuery(router).extend({
      rootId: z
        .uuid()
        .optional()
        .openapi({ param: { name: "rootId", in: "query" }, description: "UUID v7" }),
      status: NodeStatus.optional().openapi({ param: { name: "status", in: "query" } }),
      scope: z
        .string()
        .min(1)
        .optional()
        .openapi({ param: { name: "scope", in: "query" } }),
    }),
  },
  responses: { 200: listResponse(NodeTree), ...problems(400, 401, 403, 422, 429, 500) },
});

const createNodeRoute = createRoute({
  method: "post",
  path: "/api/v1/nodes",
  operationId: "createNode",
  tags: ["nodes"],
  request: { body: jsonBody(CreateNodeInput) },
  responses: {
    201: { ...okResponse(Node, "作成した"), headers: { Location: { description: "作成したリソースの URL", schema: { type: "string" } } } },
    ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500),
  },
});

const getNodeRoute = createRoute({
  method: "get",
  path: "/api/v1/nodes/{nodeId}",
  operationId: "getNode",
  tags: ["nodes"],
  request: { params: NodeParam },
  responses: { 200: okResponse(NodeDetail), ...problems(401, 403, 404, 429, 500) },
});

const updateNodeRoute = createRoute({
  method: "patch",
  path: "/api/v1/nodes/{nodeId}",
  operationId: "updateNode",
  tags: ["nodes"],
  request: { params: NodeParam, body: jsonBody(UpdateNodeInput) },
  responses: { 200: okResponse(Node), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** タスクの木のルート */
export const nodeRoutes = router
  .openapi(listNodesRoute, async (c) => {
    const { trees, next } = await loadTrees(c.env.DB, c.req.valid("query"));
    return list(c, trees, next);
  })
  .openapi(createNodeRoute, async (c) => {
    const now = c.var.clock.now();
    const row = await createNode(c.env, c.req.valid("json"), { by: "owner", now, traceId: c.var.traceId });
    // オーナーが頼んだタスクは、勤務時間外の社員を呼び出してでも進める
    if (row.assignee !== null) await notifyStaff(c.env, row.assignee, now, true);
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
    if (row.assignee !== null && (change.assignee !== undefined || change.status === "todo")) await notifyStaff(c.env, row.assignee, now, true);
    const { node } = await loadDetail(c.env, row.id);
    return ok(c, node);
  });
