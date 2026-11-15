// 社員のツールを呼ぶ口 (POST /ws/v1/tools/{toolName})。作業トークン、止まり、今のタスク、役、入力、ルールの判断を確かめてからゲートウェイが動かす (社員が考えるの 3.5、タスクとレビューの 1.2)
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, decide, recordedText, TOOL_NAME, TOOL_NAME_MAX, ToolCallInput, ToolResult, toOperation } from "@know-office/core";
import type { GateEnv } from "../env.ts";
import type { ExtensionDefinition } from "../extensions/define.ts";
import { ensureRunning, staffOf } from "../guard/actions.ts";
import { observe } from "../guard/observe.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { ruleContext } from "./decisions.ts";
import { findNode } from "./nodes.ts";
import { bearer, type Caller, ticketTask } from "./ticket.ts";
import { prepareTool } from "./tools.ts";

const ToolParam = z.object({ toolName: z.string().max(TOOL_NAME_MAX).regex(TOOL_NAME).openapi({ param: { name: "toolName", in: "path" } }) }).strict();

const toolRoute = createRoute({
  method: "post",
  path: "/ws/v1/tools/{toolName}",
  operationId: "callStaffTool",
  tags: ["workspace-gate"],
  request: { params: ToolParam, body: { content: { "application/json": { schema: ToolCallInput } }, required: true } },
  responses: { 200: okResponse(ToolResult), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 500) },
});

/**
 * ワークスペースの受け手に、社員のツールのルートを足す
 * @param app 送ったワークスペースを結んだ受け手の Hono
 * @param caller 送ったワークスペース
 * @param extensions 読み込んだ拡張
 */
export function toolRoutes(app: OpenAPIHono<GateEnv>, caller: Caller, extensions: readonly ExtensionDefinition[]): void {
  app.openapi(toolRoute, async (c) => {
    const { toolName } = c.req.valid("param");
    const { toolInput } = c.req.valid("json");
    const now = c.var.clock.now();
    const { staffId, nodeId } = await ticketTask(c.env, bearer(c.req.header("authorization")), caller, now);
    await ensureRunning(c.env, staffId, nodeId);
    // 前のタスクの作業トークンでは、今のタスクを読まないツールと拡張のツールも動かさない。タスクを持っていない時も断る
    const current = await staffOf(c.env, staffId).status(now);
    if (current.nodeId !== nodeId) throw new AppError("conflict", "作業トークンのタスクは今のタスクでない");
    const call = { staffId, tool: toolName, input: toolInput, now, traceId: c.var.traceId, guard: c.var.guard };
    // 役で使えないツールは 404、形の違う入力は 422 で、ルールの判断より先に断る
    const run = await prepareTool(c.env, c.var.forge, call, extensions);
    // フックが聞いた判断の後に役や拡張が変わっても、動かす前に判断し直す。tool_calls と tool_call の数えは判断のルートが持つので重ねない
    const node = await findNode(c.env.DB, nodeId);
    const op = toOperation(`mcp__staff__${toolName}`, toolInput);
    const decision = decide(op, await ruleContext(c.env, { staffId, nodeId, scope: node.scope }, op, extensions));
    if (!decision.allow) {
      await observe(c.env, { type: "rule_denied", staffId, nodeId, operation: op.kind, target: recordedText(op.target) }, now, c.var.guard, c.var.traceId);
      throw new AppError("rule_denied", decision.reason);
    }
    return ok(c, await run());
  });
}
