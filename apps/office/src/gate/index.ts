// ゲートウェイ。API はすべて /api/v1 の下に置き、ほかのパスは画面のファイルを返す
import type { Clock, Fetcher } from "@know-office/core";
import { createApp } from "./app.ts";
import type { ExtensionDefinition } from "./extensions/define.ts";
import { INSTALLED } from "./extensions/installed.ts";
import type { GitHubAccess } from "./github/forge.ts";
import type { GuardDeps } from "./guard/deps.ts";
import { registerComponents } from "./openapi.ts";
import { attendanceRoutes } from "./routes/attendance.ts";
import { extensionRoutes } from "./routes/extensions.ts";
import { githubRoutes } from "./routes/github.ts";
import { findingRoutes } from "./routes/findings.ts";
import { guardRoutes } from "./routes/guard.ts";
import { nodeRoutes } from "./routes/nodes.ts";
import { noticeRoutes } from "./routes/notices.ts";
import { orgRoutes } from "./routes/org.ts";
import { passkeyRoutes } from "./routes/passkeys.ts";
import { recordRoutes } from "./routes/records.ts";
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
 * @param options.github GitHub App の鍵の出し手。無ければ GitHub とつないでいない
 * @returns ゲートウェイ
 */
export function createGate(options: { clock?: Clock; fetch?: Fetcher; guard?: GuardDeps; extensions?: readonly ExtensionDefinition[]; github?: GitHubAccess } = {}) {
  const app = createApp(options).route("/", system).route("/", sessionRoutes).route("/", passkeyRoutes).route("/", recordRoutes).route("/", guardRoutes).route("/", attendanceRoutes)
    .route("/", nodeRoutes)
    .route("/", orgRoutes)
    .route("/", serviceRoutes)
    .route("/", settingRoutes)
    .route("/", noticeRoutes)
    .route("/", extensionRoutes(options.extensions ?? INSTALLED))
    .route("/", githubRoutes)
    .route("/", findingRoutes);
  registerComponents(app);
  return app;
}

const gate = createGate();

/** ゲートウェイの型。画面は Hono の RPC でこの型を受ける */
export type Gate = typeof gate;

export default gate;
