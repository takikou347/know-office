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

const ToolParam = z.object({ toolName: z.string().max(TOOL_NAME_MAX).regex(TOOL_NAME).openapi({ param: { name: "toolName", in: "path", description: "社員のツールの名前か、入れている拡張のツールの ext__<拡張 ID>__<ツール>" } }) }).strict();

const toolRoute = createRoute({
  method: "post",
  path: "/ws/v1/tools/{toolName}",
  operationId: "callStaffTool",
  tags: ["workspace-gate"],
  summary: "社員のツール。入力はツールごとの Zod スキーマに従う",
  description: "toolInput の形式はツールごとに定義し、ゲートウェイが検証する。ワークスペースの MCP の受け手 staff が、社員の役で使えるツールを呼ぶたびに送る。",
  "x-steps": [
    "作業トークンを検証する",
    "全体、社員、タスクのどれかが止まっていれば 409 `stopped`",
    "作業トークンのタスクが社員 DO の担当中のタスクと一致することを確認する。どのツールも、前のタスクの作業トークンでは動かさない",
    "社員の役割で使えるツールかを確認し、ツールごとの Zod スキーマで入力を検証する",
    "`decide()` で可否を判断する。拒否した場合は `guard.observe` に `rule_denied` を渡して 403 で断る。`tool_calls` と `tool_call` の数えは、フックが呼ぶ `POST /ws/v1/decisions` が持つので重ねない",
    "ゲートウェイがツールを実行し、ツールごとの監査ログを残す",
  ],
  "x-errors": [
    "403 `rule_denied`: ルールの判断が拒否した",
    "404 `not_found`: この社員の役割では使えないツール、入れていない拡張のツール",
    "409 `stopped`: 社員かタスクが停止中",
    "409 `conflict`: 作業トークンのタスクが担当中のタスクと異なる、読んだ後にタスクが変わった",
    "422 `validation_failed`: ツールの名前かツールの入力の形が違う",
  ],
  security: [{ workToken: [] }],
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
