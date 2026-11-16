// ワークスペースの外向きの通信の受け手。コンテナから出る要求は宛先ごとにここへ回り、ゲートウェイが作業トークンを確かめる (社員が考えるの 1.2、3.1)
import { createRoute } from "@hono/zod-openapi";
import { AppError, CheckpointInput, type Clock, type Fetcher, fromBase64, HeartbeatInput, TranscriptPartInput } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import { createApp } from "./app.ts";
import { bodyShape } from "./body.ts";
import type { Bindings, GateEnv } from "./env.ts";
import type { ExtensionDefinition } from "./extensions/define.ts";
import { INSTALLED } from "./extensions/installed.ts";
import type { TokenCache } from "./github/app.ts";
import { relayGit, relayGitHubApi } from "./github/git.ts";
import { staffOf } from "./guard/actions.ts";
import type { GuardDeps } from "./guard/deps.ts";
import { problems } from "./openapi.ts";
import { noContent } from "./respond.ts";
import { rethrowRpc } from "./rpc.ts";
import { decisionRoutes } from "./work/decisions.ts";
import { eventRoutes } from "./work/events.ts";
import { toolRoutes } from "./work/tool-route.ts";
import { relayClaude } from "./work/relay.ts";
import { authenticateTicket, bearer, type Caller, renewTicket, ticketTask } from "./work/ticket.ts";

export type { Caller } from "./work/ticket.ts";

/** コンテナから受け手に回す宛先。ほかの宛先はコンテナの外向きの通信を切って届かなくする */
export const WORKSPACE_EGRESS = { http: ["gate.internal"], https: ["api.anthropic.com", "api.github.com", "github.com"] } as const;

/** 作業トークンを要らないルート。プロキシが送ったコンテナから社員を決める (ルートの一覧の 1.15) */
const OPEN_PATHS = new Set(["/ws/v1/heartbeat", "/ws/v1/checkpoints"]);

/** 受け手の依り所 */
export type EgressOptions = {
  /** 今の時刻 */
  clock: Clock;
  /** 自動停止が外へ頼む口 */
  guard: GuardDeps;
  /** 外への fetch。テストは代わりの Claude API に回す */
  fetch?: Fetcher;
  /** GitHub の 1 時間の鍵をためる所。無ければ入口で共にためる所 */
  githubTokens?: TokenCache;
  /** 差し込む拡張。無ければ extensions/ から読み込んだ物 */
  extensions?: readonly ExtensionDefinition[];
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

const transcriptRoute = createRoute({
  method: "post",
  path: "/ws/v1/transcript-parts",
  operationId: "sendTranscriptPart",
  tags: ["workspace-gate"],
  request: { body: { content: { "application/json": { schema: TranscriptPartInput } }, required: true } },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 403, 409, 413, 415, 422, 500) },
});

/**
 * 作業トークンを見る所を返す。Claude は x-api-key、git は Basic の合言葉、ほかは Authorization の Bearer に入る
 * @param headers 要求のヘッダー
 * @param host 宛先
 * @returns 作業トークン。無ければ空
 */
function ticketOf(headers: Headers, host: string): string {
  if (host === "api.anthropic.com") return headers.get("x-api-key") ?? "";
  if (host === "github.com") return basicPassword(headers.get("authorization"));
  return bearer(headers.get("authorization"));
}

/**
 * Basic の合言葉を取り出す。git はユーザー名を x-access-token にして、合言葉に作業トークンを入れる
 * @param header Authorization の値
 * @returns 合言葉。無いか形が違えば空
 */
function basicPassword(header: string | null): string {
  const encoded = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(header ?? "")?.[1];
  const bytes = encoded === undefined ? null : fromBase64(encoded);
  if (!bytes) return "";
  const text = new TextDecoder().decode(bytes);
  const colon = text.indexOf(":");
  return colon < 0 ? "" : text.slice(colon + 1);
}

/**
 * ワークスペースからの要求を受けるゲートウェイを作る。送ったワークスペースは要求ごとに結ぶ
 * @param caller 送ったワークスペース
 * @param options 時刻と自動停止の口
 * @returns /ws/v1/ と、Claude と GitHub の宛先を受ける Hono
 */
function createWorkspaceGate(caller: Caller, options: EgressOptions) {
  const app = createApp({ clock: options.clock, guard: options.guard, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.githubTokens ? { githubTokens: options.githubTokens } : {}) });
  // 作業トークンの要るルートは、ルートの有る無しより先に確かめる。作業トークン無しでルートを探れないようにする
  app.use(
    "*",
    createMiddleware<GateEnv>(async (c, next) => {
      const host = new URL(c.req.url).hostname;
      if (host === "gate.internal" && OPEN_PATHS.has(c.req.path)) {
        // 作業トークンが無くても社員 DO まで届くので、コンテナの中から叩き続けられないよう、ワークスペースごとに数える
        const guard = c.env.GUARD.get(c.env.GUARD.idFromName("guard"));
        const { retryAfter } = await guard.admit(`workspace:${caller.workspaceId}`, "workspace", c.var.clock.now());
        if (retryAfter !== null) throw new AppError("rate_limited", "要求が多すぎる", { headers: { "Retry-After": String(retryAfter) } });
      } else {
        const token = ticketOf(c.req.raw.headers, host);
        if (token === "") throw new AppError("unauthenticated", "作業トークンが無い");
        const ticket = await authenticateTicket(c.env, token, caller, c.var.clock.now(), c.var.guard);
        // Claude のプロキシは Anthropic の形のままで、ゲートウェイのルートに入れない (社員が考えるの 1.2)
        if (host === "api.anthropic.com") return relayClaude(c, ticket);
        if (host === "github.com") return relayGit(c, ticket);
        if (host === "api.github.com") return relayGitHubApi(c, ticket);
      }
      return next();
    }),
  );
  // 本文の形はゲートウェイのルートだけで確かめる。Claude への本文は 1MB を超えうるので、プロキシが確かめる
  app.use("/ws/*", bodyShape);
  app.openapi(heartbeatRoute, async (c) => {
    await staffOf(c.env, caller.staffId).heartbeat(c.var.clock.now()).catch(rethrowRpc);
    return noContent(c);
  });
  app.openapi(checkpointRoute, async (c) => {
    const input = c.req.valid("json");
    const now = c.var.clock.now();
    // DO の RPC を越えると AppError のクラスが消えるので、断った code を戻す
    await staffOf(c.env, caller.staffId).checkpoint(input, now).catch(rethrowRpc);
    await renewTicket(c.env, caller.staffId, input.nodeId, now);
    return noContent(c);
  });
  app.openapi(transcriptRoute, async (c) => {
    const input = c.req.valid("json");
    const now = c.var.clock.now();
    // 記録は作業トークンのタスクの物として置く。本文からタスクを決めない
    const { staffId, nodeId } = await ticketTask(c.env, bearer(c.req.header("authorization")), caller, now);
    await staffOf(c.env, staffId).appendTranscript(nodeId, input, now).catch(rethrowRpc);
    return noContent(c);
  });
  eventRoutes(app, caller);
  decisionRoutes(app, caller, options.extensions ?? INSTALLED);
  toolRoutes(app, caller, options.extensions ?? INSTALLED);
  app.all("*", (c) => {
    const host = new URL(c.req.url).hostname;
    if (host !== "gate.internal") throw new AppError("unavailable", `${host} へのプロキシは無い`);
    throw new AppError("not_found", `${c.req.path} は存在しない`);
  });
  return app;
}

/**
 * コンテナから出た要求を宛先で分け、ゲートウェイ、Claude、GitHub の宛先の決まった番号だけをゲートウェイで受ける。ほかは 403 で断る
 * @param request コンテナから出た要求
 * @param env バインディング
 * @param caller 送ったワークスペース。コンテナを起こした DO が受け手に結ぶ
 * @param options 時刻と自動停止の口
 * @returns 返事
 */
export async function routeEgress(request: Request, env: Bindings, caller: Caller, options: EgressOptions): Promise<Response> {
  const url = new URL(request.url);
  // URL は決まった番号 (http の 80、https の 443) を空にする。ほかの番号には出さない
  const allowed =
    url.port === "" &&
    ((url.protocol === "http:" && WORKSPACE_EGRESS.http.some((h) => h === url.hostname)) || (url.protocol === "https:" && WORKSPACE_EGRESS.https.some((h) => h === url.hostname)));
  if (!allowed) {
    return new Response(JSON.stringify({ type: "urn:know-office:problem:forbidden", title: "Forbidden", status: 403, detail: "この宛先には出られない", code: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/problem+json" },
    });
  }
  return createWorkspaceGate(caller, options).fetch(request, env);
}
