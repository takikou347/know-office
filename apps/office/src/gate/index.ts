// ゲートウェイ。API はすべて /api/v1 の下に置き、ほかのパスは画面のファイルを返す
import type { Clock, Fetcher } from "@know-office/core";
import { createApp } from "./app.ts";
import { registerComponents } from "./openapi.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { system } from "./routes/system.ts";

/**
 * 全部のルートを付けたゲートウェイを作る
 * @param options テストは決まった時刻と、外への fetch の代わりを渡す
 * @param options.clock 今の時刻
 * @param options.fetch 外への fetch
 * @returns ゲートウェイ
 */
export function createGate(options: { clock?: Clock; fetch?: Fetcher } = {}) {
  const app = createApp(options).route("/", system).route("/", sessionRoutes);
  registerComponents(app);
  return app;
}

const gate = createGate();

/** ゲートウェイの型。画面は Hono の RPC でこの型を受ける */
export type Gate = typeof gate;

export default gate;
