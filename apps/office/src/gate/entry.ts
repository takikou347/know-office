// Worker の入口の fetch。画面の HTML は nonce を入れて返し、開発の代わりのワークスペースの道と開発の通しの社員の道を先に見て、ほかはゲートウェイに渡す。worker.ts が default export の fetch に使う
import type { ExecutionContext } from "@cloudflare/workers-types";
import { systemClock } from "@know-office/core";
import type { Bindings } from "./env.ts";
import { type GuardDeps, UNCONNECTED_DEPS } from "./guard/deps.ts";
import { connectReview } from "./guard/review.ts";
import gate from "./index.ts";
import { screenResponse } from "./screen-html.ts";
import { devWorkspaceEgress } from "./work/dev-container.ts";
import { devStaffRoute } from "./work/dev-staff.ts";

/**
 * ゲートウェイが受ける道かを見る。ほかの道は画面を返す
 * @param path 道
 * @returns /api の下、GitHub の通知の道、/__dev の下なら true
 */
function toGate(path: string): boolean {
  return path.startsWith("/api/") || path === "/hooks/v1/github" || path.startsWith("/__dev/");
}

/**
 * 入口に届いた要求を受ける。開発の代わりのワークスペースが送る出来事と、開発の通しの社員の道だけは、development の時にゲートウェイの前で受ける
 * @param request 要求
 * @param env バインディング
 * @param ctx 実行の文脈。テストは省く
 * @returns 返事
 */
export function entryFetch(request: Request, env: Bindings, ctx?: ExecutionContext): Response | Promise<Response> {
  const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
  if (!toGate(new URL(request.url).pathname)) return screenResponse(request, env);
  // 開発の代わりのワークスペースも、止めた時は返事の後にレビュー担当のモデルに聞く
  const guard: GuardDeps = { ...UNCONNECTED_DEPS, review: connectReview(env, (input, init) => fetch(input, init), systemClock), ...(waitUntil ? { later: waitUntil } : {}) };
  return devWorkspaceEgress(request, env, { clock: systemClock, guard, ...(waitUntil ? { waitUntil } : {}) }) ?? devStaffRoute(request, env, { clock: systemClock }) ?? gate.fetch(request, env, ctx);
}
