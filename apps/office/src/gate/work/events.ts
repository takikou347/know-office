// ワークスペースが送る出来事を受ける口 (POST /ws/v1/events)。発言を会話に、ツールの結果を自動停止に、チェックポイントを社員 DO に、エラーをエラーログに、終わりをタスクに渡す (社員が考えるの 3.2、3.7)
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { AgentEventsInput, AppError, type AgentEvent, type Clock, type StaffId, type WorkResult } from "@know-office/core";
import type { Bindings, GateEnv } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { recordError } from "../ledger/errors.ts";
import { ensureRunning, staffOf } from "../guard/actions.ts";
import { observe } from "../guard/observe.ts";
import { problems } from "../openapi.ts";
import { noContent } from "../respond.ts";
import { rethrowRpc } from "../rpc.ts";
import { finishTask } from "./loop.ts";
import { addStaffMessage, reachCheckpoint } from "./progress.ts";
import { AUTH_FAILED_NOTICE, noticeOnce, runFailed } from "./run.ts";
import { bearer, type Caller, revokeTaskTickets, ticketTask } from "./ticket.ts";

const eventsRoute = createRoute({
  method: "post",
  path: "/ws/v1/events",
  operationId: "sendAgentEvents",
  tags: ["workspace-gate"],
  request: { body: { content: { "application/json": { schema: AgentEventsInput } }, required: true } },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 403, 409, 413, 415, 422, 500) },
});

/** 1 つの要求で出来事を渡す先 */
type EventContext = { env: Bindings; staffId: StaffId; nodeId: string; now: number; traceId: string; clock: Clock; guard: GuardDeps };

/**
 * 出来事を 1 つ渡す。並びの順に渡し、断った所で止める
 * @param ctx 社員、作業トークンのタスク、時刻、要求
 * @param event 出来事
 * @throws conflict 作業トークンのタスクと違うタスクの出来事、今のタスクと違うチェックポイント、同時に終えた時
 */
async function apply(ctx: EventContext, event: AgentEvent): Promise<void> {
  const { env, staffId, nodeId, now, traceId } = ctx;
  switch (event.kind) {
    case "message":
      await addStaffMessage(env, { staffId, nodeId, body: event.body }, now, traceId);
      return;
    case "tool_result":
      // 落ちたテストの続きは自動停止が数える。会話にも記録にも書かない
      await observe(env, { type: "command_result", staffId, nodeId, command: event.command, exitCode: event.exitCode, failedCheck: event.failedChecks[0] ?? null }, now, ctx.guard, traceId);
      return;
    case "checkpoint":
      if (event.nodeId !== nodeId) throw new AppError("conflict", "作業トークンのタスクと違う");
      await reachCheckpoint(env, staffId, { kind: event.checkpoint, nodeId, ...(event.note === undefined ? {} : { note: event.note }) }, now, traceId);
      return;
    case "error":
      // 文は鍵の形を伏せて 200 字までに切って残す。名前は決めた物だけ
      await recordError(env, { source: "workspace", level: "error", code: event.name, error: new Error(event.message), traceId }, ctx.clock);
      // 鍵の失敗は社員ごとでなく 1 件だけ知らせる。読むまでどの社員も呼び出しを始めない
      if (event.name === "sdk_auth_failed")
        await noticeOnce(env, { kind: AUTH_FAILED_NOTICE, title: "Claude の鍵が断られた", body: "社員は Claude を呼べない。設定で鍵を確かめ、この通知を読むと社員が続きを始める" }, now);
      return;
    case "result":
      await settle(ctx, event.nodeId, event.result);
      return;
  }
}

/**
 * 呼び出しの終わりを渡す。今のタスクでない終わりは何もせず、持っているタスクの呼び出しが始まっていなければ始める
 * @param ctx 社員、作業トークンのタスク、時刻、要求
 * @param target 終わったタスク
 * @param result 結果
 * @throws conflict 作業トークンのタスクと違う時、同時に終えた時
 */
async function settle(ctx: EventContext, target: string, result: WorkResult): Promise<void> {
  const { env, staffId, nodeId, now } = ctx;
  if (target !== nodeId) throw new AppError("conflict", "作業トークンのタスクと違う");
  const staff = staffOf(env, staffId);
  const { nodeId: current } = await staff.status(now);
  if (current !== nodeId) {
    // 先にタスクを離れた後の終わり。ワークスペースが空いたので、持っているタスクを始める
    await staff.arm(now).catch(rethrowRpc);
    return;
  }
  if (result === "done") {
    await ensureRunning(env, staffId, nodeId);
    await finishTask(env, staffId, nodeId, now);
    await revokeTaskTickets(env, staffId, nodeId, "finished", now);
    await staff.markRun(nodeId, "done");
    return;
  }
  if (result === "handed_back") await runFailed(env, staffId, nodeId, "sdk_failed", now);
  // stopped と continued は、止めた側と続きを始めた側が扱う
}

/**
 * ワークスペースの受け手に、出来事のルートを足す
 * @param app 送ったワークスペースを結んだ受け手の Hono
 * @param caller 送ったワークスペース
 */
export function eventRoutes(app: OpenAPIHono<GateEnv>, caller: Caller): void {
  app.openapi(eventsRoute, async (c) => {
    const { events } = c.req.valid("json");
    const now = c.var.clock.now();
    // 社員とタスクは作業トークンから決める。本文からは決めない
    const { staffId, nodeId } = await ticketTask(c.env, bearer(c.req.header("authorization")), caller, now);
    const ctx: EventContext = { env: c.env, staffId, nodeId, now, traceId: c.var.traceId, clock: c.var.clock, guard: c.var.guard };
    for (const event of events) await apply(ctx, event);
    return noContent(c);
  });
}
