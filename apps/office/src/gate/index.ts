// ゲートウェイ。API はすべて /api/v1 の下に置き、ほかのパスは画面のファイルを返す
import type { Clock, Fetcher } from "@know-office/core";
import { createApp } from "./app.ts";
import type { ExtensionDefinition } from "./extensions/define.ts";
import { INSTALLED } from "./extensions/installed.ts";
import type { TokenCache } from "./github/app.ts";
import type { GitHubAccess } from "./github/forge.ts";
import type { GuardDeps } from "./guard/deps.ts";
import { registerComponents } from "./openapi.ts";
import { attendanceRoutes } from "./routes/attendance.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { devloopRoutes } from "./routes/devloop.ts";
import { liveRoutes } from "./routes/live.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { mcpClientRoutes } from "./routes/mcp-clients.ts";
import { messageRoutes } from "./routes/messages.ts";
import { staffRoutes } from "./routes/staff.ts";
import { extensionRoutes } from "./routes/extensions.ts";
import { githubRoutes, hookRoutes } from "./routes/github.ts";
import { findingRoutes } from "./routes/findings.ts";
import { guardRoutes } from "./routes/guard.ts";
import { guardTuningRoutes } from "./routes/guard-tuning.ts";
import { guardKeyRoutes } from "./routes/keys.ts";
import { nodeRoutes } from "./routes/nodes.ts";
import { noticeRoutes } from "./routes/notices.ts";
import { orgRoutes } from "./routes/org.ts";
import { passkeyRoutes } from "./routes/passkeys.ts";
import { recordRoutes } from "./routes/records.ts";
import { traceRoutes } from "./routes/traces.ts";
import { reviewLspRoutes } from "./routes/review-lsp.ts";
import { reviewReadRoutes } from "./routes/review-reads.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { serviceRoutes } from "./routes/services.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { settingRoutes } from "./routes/settings.ts";
import { system } from "./routes/system.ts";

/**
 * 全部のルートを付けたゲートウェイを作る
 * @param options テストは決まった時刻と、外への fetch の代わりを渡す
 * @param options.clock 今の時刻
 * @param options.fetch 外への fetch
 * @param options.guard 自動停止が外へ頼む口
 * @param options.extensions 差し込む拡張。無ければ extensions/ から読み込んだ物
 * @param options.github GitHub App の鍵の出し手。テストが決まった鍵を渡す。無ければ vault の App の鍵から作る
 * @param options.githubTokens GitHub の 1 時間の鍵をためる所
 * @returns ゲートウェイ
 */
export function createGate(options: { clock?: Clock; fetch?: Fetcher; guard?: GuardDeps; extensions?: readonly ExtensionDefinition[]; github?: GitHubAccess; githubTokens?: TokenCache } = {}) {
  const app = createApp(options).route("/", system).route("/", sessionRoutes).route("/", passkeyRoutes).route("/", recordRoutes).route("/", traceRoutes).route("/", guardRoutes).route("/", guardTuningRoutes).route("/", guardKeyRoutes).route("/", attendanceRoutes)
    .route("/", nodeRoutes)
    .route("/", reviewRoutes)
    .route("/", reviewReadRoutes)
    .route("/", reviewLspRoutes)
    .route("/", orgRoutes)
    .route("/", serviceRoutes)
    .route("/", settingRoutes)
    .route("/", noticeRoutes)
    .route("/", staffRoutes)
    .route("/", messageRoutes)
    .route("/", liveRoutes)
    .route("/", dashboardRoutes)
    .route("/", extensionRoutes(options.extensions ?? INSTALLED))
    .route("/", githubRoutes)
    .route("/", devloopRoutes)
    .route("/", hookRoutes)
    .route("/", findingRoutes)
    .route("/", mcpClientRoutes)
    .route("/", mcpRoutes);
  registerComponents(app);
  return app;
}

const gate = createGate();

/** ゲートウェイの型。画面は Hono の RPC でこの型を受ける */
export type Gate = typeof gate;

export default gate;
