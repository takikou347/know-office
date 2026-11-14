// ワークスペースのフックが聞くルールの判断 (POST /ws/v1/decisions)。core の decide() で決め、tool_calls と自動停止に渡す (社員が考えるの 3.4)
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  AppError,
  DecideInput,
  Decision,
  DEFAULT_RULES,
  decide,
  INHERITED_SETTINGS,
  maskSecrets,
  newId,
  type Operation,
  type RuleContext,
  type StaffId,
  toOperation,
} from "@know-office/core";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { stops } from "../db/main.ts";
import { toolCalls } from "../db/records.ts";
import type { Bindings, GateEnv } from "../env.ts";
import { openStops, staffOf } from "../guard/actions.ts";
import { observe } from "../guard/observe.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { loadOfficeDefaults, serviceRules } from "../services/settings.ts";
import { clockAt } from "./attendance.ts";
import { findNode, recordsOf } from "./nodes.ts";
import { type Caller, ticketTask } from "./ticket.ts";

/** tool_calls と出来事に残す相手の長さの上限。長い命令で記録が膨らまないようにする */
const MAX_TARGET = 500;

const decideRoute = createRoute({
  method: "post",
  path: "/ws/v1/decisions",
  operationId: "decideTool",
  tags: ["workspace-gate"],
  request: { body: { content: { "application/json": { schema: DecideInput } }, required: true } },
  responses: { 200: okResponse(Decision), ...problems(400, 401, 403, 409, 413, 415, 422, 500) },
});

/**
 * 社員、タスク、全体のどれかが止まっていれば断る
 * @param env バインディング
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @throws stopped 止めた記録がまだ再開していない時
 */
async function ensureRunning(env: Bindings, staffId: StaffId, nodeId: string): Promise<void> {
  const open = await openStops(
    env.DB,
    or(and(eq(stops.scope, "office"), eq(stops.target, "office")), and(eq(stops.scope, "staff"), eq(stops.target, staffId)), and(eq(stops.scope, "task"), eq(stops.target, nodeId))),
  );
  if (open.length > 0) throw new AppError("stopped", "社員かタスクが止まっている");
}

/**
 * タスクの範囲の触れない所を読む。サービスのタスクはサービスの設定、ほかは office の初期値を使い、判断のたびに読む
 * @param env バインディング
 * @param scope タスクの範囲 (office かサービスの ID)
 * @returns 触れない所
 */
async function protectedPathsOf(env: Bindings, scope: string): Promise<string[]> {
  if (scope !== "office") return (await serviceRules(env.DB, scope)).protectedPaths;
  return INHERITED_SETTINGS.protectedPaths.parse((await loadOfficeDefaults(env.DB)).protectedPaths.value);
}

/**
 * 記録と出来事に入れる相手。鍵の形を伏せ、長さを切る
 * @param op 操作
 * @returns 残す相手
 */
function recordedTarget(op: Operation): string {
  return maskSecrets(op.target).slice(0, MAX_TARGET);
}

/**
 * 作業トークンを Authorization から取り出す。受け手が先に確かめている
 * @param header Authorization の値
 * @returns 作業トークン
 */
function bearer(header: string | undefined): string {
  return /^Bearer (\S+)$/.exec(header ?? "")?.[1] ?? "";
}

/**
 * ワークスペースの受け手に、ルールの判断のルートを足す
 * @param app 送ったワークスペースを結んだ受け手の Hono
 * @param caller 送ったワークスペース
 */
export function decisionRoutes(app: OpenAPIHono<GateEnv>, caller: Caller): void {
  app.openapi(decideRoute, async (c) => {
    const input = c.req.valid("json");
    const now = c.var.clock.now();
    const { staffId, nodeId } = await ticketTask(c.env, bearer(c.req.header("authorization")), caller, now);
    await ensureRunning(c.env, staffId, nodeId);
    const node = await findNode(c.env.DB, nodeId);
    const op = toOperation(input.toolName, input.toolInput);
    const staff = staffOf(c.env, staffId);
    // 外部の文章の印はオーナーの情報の判断だけが見るので、その時だけ社員 DO に聞く
    const ctx: RuleContext = {
      ...DEFAULT_RULES,
      protectedPaths: await protectedPathsOf(c.env, node.scope),
      external: op.kind === "owner_info.read" && (await staff.externalSources(nodeId)).length > 0,
    };
    const decision = decide(op, ctx);
    const target = recordedTarget(op);
    await drizzle(recordsOf(c.env, now))
      .insert(toolCalls)
      .values({
        id: newId(clockAt(now)),
        at: now,
        staffId,
        nodeId,
        scope: node.scope,
        tool: input.toolName.slice(0, MAX_TARGET),
        opKind: op.kind,
        target,
        allowed: decision.allow,
        reason: decision.reason,
        ms: c.var.clock.now() - now,
        traceId: c.var.traceId,
      });
    const deps = c.var.guard;
    const traceId = c.var.traceId;
    let stopped = (await observe(c.env, { type: "tool_call", staffId }, now, deps, traceId)).action === "stop";
    // 鍵とオーナーの情報への試みは、タスクを止める rule_denied より先に渡す。先にタスクを止めると外部の文章の印が消え、持ち出しを見逃す
    if (op.kind === "secret.read" || op.kind === "owner_info.read") {
      stopped = (await observe(c.env, { type: "sensitive_access", staffId, nodeId, item: target }, now, deps, traceId)).action === "stop" || stopped;
    }
    if (decision.marksExternal) await observe(c.env, { type: "external_read", staffId, nodeId, source: target }, now, deps, traceId);
    // 社員ごと止めた後は、そのタスクを重ねて止めない
    if (!decision.allow && !stopped) await observe(c.env, { type: "rule_denied", staffId, nodeId, operation: op.kind, target }, now, deps, traceId);
    return ok(c, { allow: decision.allow, reason: decision.reason });
  });
}
