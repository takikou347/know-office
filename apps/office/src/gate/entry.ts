// Worker の入口の fetch。開発の代わりのワークスペースの道を先に見て、ほかはゲートウェイに渡す。worker.ts が default export の fetch に使う
import type { ExecutionContext } from "@cloudflare/workers-types";
import { systemClock } from "@know-office/core";
import type { Bindings } from "./env.ts";
import { UNCONNECTED_DEPS } from "./guard/deps.ts";
import gate from "./index.ts";
import { devWorkspaceEgress } from "./work/dev-container.ts";

/**
 * 入口に届いた要求を受ける。開発の代わりのワークスペースが送る出来事だけは、development の時にゲートウェイの前で受け手に回す
 * @param request 要求
 * @param env バインディング
 * @param ctx 実行の文脈。テストは省く
 * @returns 返事
 */
export function entryFetch(request: Request, env: Bindings, ctx?: ExecutionContext): Response | Promise<Response> {
  return devWorkspaceEgress(request, env, { clock: systemClock, guard: UNCONNECTED_DEPS }) ?? gate.fetch(request, env, ctx);
}
