// Worker の入口。ゲートウェイ、定期ジョブ、Durable Objects のクラスを出す。wrangler の main はここ
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { systemClock } from "@know-office/core";
import type { Bindings } from "./env.ts";
import gate from "./index.ts";
import { DAILY_CRON, runDaily } from "./jobs/daily.ts";
import { runScheduled } from "./jobs/health.ts";

export { GuardDO } from "./do/guard.ts";
export { RecorderDO } from "./do/recorder.ts";
export { StaffDO } from "./do/staff.ts";
export { WorkspaceDO, WorkspaceEgress } from "./do/workspace.ts";

export default {
  fetch: gate.fetch,
  // wrangler.jsonc の triggers.crons で、5 分ごとと毎日 0 時 5 分に呼ばれる
  scheduled: (controller: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    if (controller.cron === DAILY_CRON) runDaily(env, ctx, systemClock);
    else runScheduled(env, ctx, systemClock);
  },
};
