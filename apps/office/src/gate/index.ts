// ゲートウェイ。API はすべて /api/v1 の下に置き、ほかのパスは画面のファイルを返す
import type { Clock, Fetcher } from "@know-office/core";
import { createApp } from "./app.ts";
import type { GuardDeps } from "./guard/deps.ts";
import { registerComponents } from "./openapi.ts";
import { guardRoutes } from "./routes/guard.ts";
import { passkeyRoutes } from "./routes/passkeys.ts";
import { recordRoutes } from "./routes/records.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { system } from "./routes/system.ts";

/**
 * 全部のルートを付けたゲートウェイを作る
 * @param options テストは決まった時刻と、外への fetch の代わりを渡す
 * @param options.clock 今の時刻
 * @param options.fetch 外への fetch
 * @param options.guard 自動停止が外へ頼む口
 * @returns ゲートウェイ
 */
export function createGate(options: { clock?: Clock; fetch?: Fetcher; guard?: GuardDeps } = {}) {
  const app = createApp(options).route("/", system).route("/", sessionRoutes).route("/", passkeyRoutes).route("/", recordRoutes).route("/", guardRoutes);
  registerComponents(app);
  return app;
}

const gate = createGate();

/** ゲートウェイの型。画面は Hono の RPC でこの型を受ける */
export type Gate = typeof gate;

export default gate;
