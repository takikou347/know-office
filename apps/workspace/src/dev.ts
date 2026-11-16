// 開発環境の代わりのワークスペース。本物と同じサーバーと Runner を手元の空いた番号で起こし、SDK は手元の代わりの Claude API だけを呼ぶ (ログインと記録の 3.9、社員が考えるの 3.1)
import { type AgentEvent, AppError, log } from "@know-office/core";
import type { Agent } from "./agent.ts";
import { Runner } from "./run.ts";
import { sdkAgent } from "./sdk.ts";
import { createWorkspaceServer } from "./server.ts";

/** 手元の代わりの Claude API の宛先。これでない宛先には SDK を向けない */
const LOCAL_ANTHROPIC = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/anthropic$/;

/** 起こした代わりのワークスペース */
export type DevWorkspace = {
  /** Node のサーバーの番号 */
  port: number;
  /** ゲートウェイへ送るはずだった出来事。代わりのワークスペースはゲートウェイの受け手を通らないので、ここに残す */
  events: AgentEvent[][];
  /** 走っている呼び出しを止めてサーバーを閉じる */
  close(): Promise<void>;
};

/**
 * 代わりのワークスペースを 127.0.0.1 の空いた番号で起こす
 * @param options ゲートウェイの鍵、代わりの Claude API の宛先、呼び出しの代わり
 * @param options.key ゲートウェイの鍵
 * @param options.anthropicUrl 代わりの Claude API の宛先 (DEV_FAKES_URL/anthropic)
 * @param options.agent SDK の呼び出し。省くと本物の SDK
 * @returns 起こした物
 * @throws internal 代わりの Claude API の宛先が手元でない時。本物の Claude には向けない
 */
export async function startDevWorkspace(options: { key: string; anthropicUrl: string; agent?: Agent }): Promise<DevWorkspace> {
  if (!LOCAL_ANTHROPIC.test(options.anthropicUrl)) throw new AppError("internal", "代わりの Claude API が手元の宛先でない");
  const events: AgentEvent[][] = [];
  const runner = new Runner(
    options.agent ?? sdkAgent(),
    (error) => log("warn", "dev_run_failed", { error: error instanceof Error ? error.name : "unknown" }),
    undefined,
    undefined,
    { report: (_ticket, sent) => Promise.resolve(void events.push(sent)) },
    options.anthropicUrl,
  );
  const server = createWorkspaceServer(runner, options.key);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new AppError("internal", "代わりのワークスペースの番号が分からない");
  const { port } = address;
  return {
    port,
    events,
    close: async () => {
      if (runner.running) await runner.abort("dev_stop");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
