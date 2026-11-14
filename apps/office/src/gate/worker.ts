// Worker の入口。ゲートウェイ、定期ジョブ、Durable Objects のクラスを出す。wrangler の main はここ
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { systemClock } from "@know-office/core";
import type { Bindings } from "./env.ts";
import gate from "./index.ts";
import { checkStorage } from "./jobs/health.ts";

export { GuardDO } from "./do/guard.ts";
export { RecorderDO } from "./do/recorder.ts";

export default {
  fetch: gate.fetch,
  // wrangler.jsonc の triggers.crons で 5 分ごとに呼ばれる
  scheduled: (_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(checkStorage(env, systemClock));
  },
};
