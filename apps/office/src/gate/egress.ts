// ワークスペースの外向きの通信の受け手。コンテナから出る要求は宛先ごとにここへ回り、ゲートウェイが作業トークンを確かめる (社員が考えるの 1.2、3.1)
import { createRoute } from "@hono/zod-openapi";
import { AppError, CheckpointInput, type Clock, HeartbeatInput } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import { createApp } from "./app.ts";
import { bodyShape } from "./body.ts";
import type { Bindings, GateEnv } from "./env.ts";
import { staffOf } from "./guard/actions.ts";
import type { GuardDeps } from "./guard/deps.ts";
import { noContent } from "./respond.ts";
import { authenticateTicket, type Caller, renewTicket } from "./work/ticket.ts";

export type { Caller } from "./work/ticket.ts";

/** コンテナから受け手に回す宛先。ほかの宛先はコンテナの外向きの通信を切って届かなくする */
export const WORKSPACE_EGRESS = { http: ["gate.internal"], https: ["api.anthropic.com", "api.github.com"] } as const;

/** 作業トークンを要らないルート。プロキシが送ったコンテナから社員を決める (ルートの一覧の 1.15) */
const OPEN_PATHS = new Set(["/ws/v1/heartbeat", "/ws/v1/checkpoints"]);

/** 受け手の依り所 */
export type EgressOptions = {
  /** 今の時刻 */
  clock: Clock;
  /** 自動停止が外へ頼む口 */
  guard: GuardDeps;
};

const heartbeatRoute = createRoute({
  method: "post",
  path: "/ws/v1/heartbeat",
  request: { body: { content: { "application/json": { schema: HeartbeatInput } }, required: true } },
  responses: { 204: { description: "成功" } },
});

const checkpointRoute = createRoute({
  method: "post",
  path: "/ws/v1/checkpoints",
  request: { body: { content: { "application/json": { schema: CheckpointInput } }, required: true } },
  responses: { 204: { description: "成功" } },
});

/**
 * 作業トークンを見る所を返す。Claude は x-api-key、ほかは Authorization の Bearer に入る
 * @param headers 要求のヘッダー
 * @param host 宛先
 * @returns 作業トークン。無ければ空
 */
function ticketOf(headers: Headers, host: string): string {
  if (host === "api.anthropic.com") return headers.get("x-api-key") ?? "";
  const match = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "");
  return match?.[1] ?? "";
}

/**
 * ワークスペースからの要求を受けるゲートウェイを作る。送ったワークスペースは要求ごとに結ぶ
 * @param caller 送ったワークスペース
 * @param options 時刻と自動停止の口
 * @returns /ws/v1/ と、Claude と GitHub の宛先を受ける Hono
 */
function createWorkspaceGate(caller: Caller, options: EgressOptions) {
  const app = createApp({ clock: options.clock, guard: options.guard });
  // 作業トークンの要るルートは、ルートの有る無しより先に確かめる。作業トークン無しでルートを探れないようにする
  app.use(
    "*",
    createMiddleware<GateEnv>(async (c, next) => {
      const host = new URL(c.req.url).hostname;
      if (!(host === "gate.internal" && OPEN_PATHS.has(c.req.path))) {
        const token = ticketOf(c.req.raw.headers, host);
        if (token === "") throw new AppError("unauthenticated", "作業トークンが無い");
        await authenticateTicket(c.env, token, caller, c.var.clock.now(), c.var.guard);
      }
      await next();
    }),
  );
  // 本文の形はゲートウェイのルートだけで確かめる。Claude への本文は 1MB を超えうるので、プロキシ (tasks.md の 7.6) が決める
  app.use("/ws/*", bodyShape);
  app.openapi(heartbeatRoute, async (c) => {
    await staffOf(c.env, caller.staffId).heartbeat(c.var.clock.now());
    return noContent(c);
  });
  app.openapi(checkpointRoute, async (c) => {
    const input = c.req.valid("json");
    const now = c.var.clock.now();
    await staffOf(c.env, caller.staffId).checkpoint(input, now);
    await renewTicket(c.env, caller.staffId, input.nodeId, now);
    return noContent(c);
  });
  app.all("*", (c) => {
    const host = new URL(c.req.url).hostname;
    // Claude のプロキシ (tasks.md の 7.6) と GitHub のプロキシ (8.4) をつなぐまでは、作業トークンを確かめた後に断る
    if (host !== "gate.internal") throw new AppError("unavailable", `${host} へのプロキシはまだ無い`);
    throw new AppError("not_found", `${c.req.path} は存在しない`);
  });
  return app;
}

/**
 * コンテナから出た要求を宛先で分け、ゲートウェイ、Claude、GitHub の宛先だけをゲートウェイで受ける。ほかは 403 で断る
 * @param request コンテナから出た要求
 * @param env バインディング
 * @param caller 送ったワークスペース。コンテナを起こした DO が受け手に結ぶ
 * @param options 時刻と自動停止の口
 * @returns 返事
 */
export async function routeEgress(request: Request, env: Bindings, caller: Caller, options: EgressOptions): Promise<Response> {
  const url = new URL(request.url);
  const allowed =
    (url.protocol === "http:" && WORKSPACE_EGRESS.http.some((h) => h === url.hostname)) || (url.protocol === "https:" && WORKSPACE_EGRESS.https.some((h) => h === url.hostname));
  if (!allowed) {
    return new Response(JSON.stringify({ type: "urn:know-office:problem:forbidden", title: "Forbidden", status: 403, detail: "この宛先には出られない", code: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/problem+json" },
    });
  }
  return createWorkspaceGate(caller, options).fetch(request, env);
}
