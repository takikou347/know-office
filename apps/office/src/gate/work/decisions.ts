// ワークスペースのフックが聞くルールの判断 (POST /ws/v1/decisions)。core の decide() で決め、tool_calls と自動停止に渡す (社員が考えるの 3.4)
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  AppError,
  DecideInput,
  Decision,
  DEFAULT_RULES,
  decide,
  INHERITED_SETTINGS,
  MAX_RECORDED,
  type Judgment,
  newId,
  type Operation,
  type RuleContext,
  type RuleDecision,
  recordedText,
  type StaffId,
  toOperation,
} from "@know-office/core";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { stops } from "../db/main.ts";
import { toolCalls } from "../db/records.ts";
import type { Bindings, GateEnv } from "../env.ts";
import { openStops, staffOf } from "../guard/actions.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { loadOfficeDefaults, serviceRules } from "../services/settings.ts";
import { clockAt } from "./attendance.ts";
import { findNode, recordsOf } from "./nodes.ts";
import { type Caller, ticketTask } from "./ticket.ts";

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
  const officeStopped = and(eq(stops.scope, "office"), eq(stops.target, "office"));
  const staffStopped = and(eq(stops.scope, "staff"), eq(stops.target, staffId));
  const taskStopped = and(eq(stops.scope, "task"), eq(stops.target, nodeId));
  const open = await openStops(env.DB, or(officeStopped, staffStopped, taskStopped));
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

/** 観察が止めた時に返す答え。ルールが通す判断でも断る */
const STOPPED: Decision = { allow: false, reason: "止めた" };

/**
 * 判断を自動停止に渡して数える。鍵とオーナーの情報への試みは、タスクを止める rule_denied より先に渡す。先にタスクを止めると外部の文章の印が消え、持ち出しを見逃す
 * @param env バインディング
 * @param input 社員、タスク、操作、判断、記録に残す相手
 * @param input.staffId 社員 ID
 * @param input.nodeId タスク ID
 * @param input.op 操作
 * @param input.decision ルールの判断
 * @param input.target 鍵を伏せて切った相手
 * @param now 今の時刻
 * @param deps 自動停止が外へ頼む口
 * @param traceId 要求のトレース ID
 * @returns rule_denied より前の出来事で止めたか
 */
async function count(
  env: Bindings,
  input: { staffId: StaffId; nodeId: string; op: Operation; decision: RuleDecision; target: string },
  now: number,
  deps: GuardDeps,
  traceId: string,
): Promise<boolean> {
  const { staffId, nodeId, op, decision, target } = input;
  const judgments: Judgment[] = [await observe(env, { type: "tool_call", staffId }, now, deps, traceId)];
  if (op.kind === "secret.read" || op.kind === "owner_info.read") judgments.push(await observe(env, { type: "sensitive_access", staffId, nodeId, item: target }, now, deps, traceId));
  if (decision.marksExternal) judgments.push(await observe(env, { type: "external_read", staffId, nodeId, source: target }, now, deps, traceId));
  const stopping = judgments.filter((j) => j.action === "stop");
  // 社員ごと止めた後は、そのタスクを重ねて止めない
  if (!decision.allow && !stopping.some((j) => j.scope === "staff")) await observe(env, { type: "rule_denied", staffId, nodeId, operation: op.kind, target }, now, deps, traceId);
  return stopping.length > 0;
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
    const target = recordedText(op.target);
    // 数えは記録より先に渡す。tool_calls に書けずに 500 を返しても、自動停止の数えには入る
    const answer: Decision = (await count(c.env, { staffId, nodeId, op, decision, target }, now, c.var.guard, c.var.traceId)) ? STOPPED : { allow: decision.allow, reason: decision.reason };
    await drizzle(recordsOf(c.env, now))
      .insert(toolCalls)
      .values({
        id: newId(clockAt(now)),
        at: now,
        staffId,
        nodeId,
        scope: node.scope,
        // tool は SDK が決めたツールの名前で鍵を入れる所ではなく、知らないツールを断った跡を名前のまま残すため伏せない (長さだけ切る)
        tool: Array.from(input.toolName).slice(0, MAX_RECORDED).join(""),
        opKind: op.kind,
        target,
        allowed: answer.allow,
        reason: answer.reason,
        ms: c.var.clock.now() - now,
        traceId: c.var.traceId,
      });
    return ok(c, answer);
  });
}
