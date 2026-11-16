// Worker の入口。ゲートウェイ、定期ジョブ、Durable Objects のクラスを出す。wrangler の main はここ
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { type Fetcher, systemClock } from "@know-office/core";
import { UNCONNECTED_DEPS } from "./guard/deps.ts";
import { devWorkspaceEgress } from "./work/dev-container.ts";
import type { Bindings } from "./env.ts";
import { UNCONNECTED_TRACKER } from "./findings/tracker.ts";
import gate from "./index.ts";
import { DAILY_CRON, runDaily } from "./jobs/daily.ts";
import { runScheduled } from "./jobs/health.ts";
import { runWeekly, type WeeklyDeps } from "./jobs/weekly.ts";

export { GuardDO } from "./do/guard.ts";
export { LiveDO } from "./do/live.ts";
export { RecorderDO } from "./do/recorder.ts";
export { StaffDO } from "./do/staff.ts";
export { WorkspaceDO, WorkspaceEgress } from "./do/workspace.ts";

// Workers の fetch は this を持たずに呼ぶと落ちるので、包んで渡す
const fetcher: Fetcher = (input, init) => fetch(input, init);

// Issue の口は GitHub の連携 (tasks.md の 8.4) までつながず、見つけた物は数えるだけにする
const weekly: WeeklyDeps = { fetch: fetcher, tracker: UNCONNECTED_TRACKER };

export default {
  // 開発の代わりのワークスペースが送る出来事だけは、development の時にゲートウェイの前で受け手に回す
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => devWorkspaceEgress(request, env, { clock: systemClock, guard: UNCONNECTED_DEPS }) ?? gate.fetch(request, env, ctx),
  // wrangler.jsonc の triggers.crons で、5 分ごと (社員の alarm を掛け、置き場などを見る) と毎日 0 時 5 分に呼ばれる。週の Cron は wrangler.jsonc に足した時から呼ばれる
  scheduled: (controller: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    if (runWeekly(controller.cron, env, ctx, systemClock, weekly)) return;
    if (controller.cron === DAILY_CRON) runDaily(env, ctx, systemClock, weekly);
    else runScheduled(env, ctx, systemClock, weekly);
  },
};
