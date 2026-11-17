// 開発環境の代わりのワークスペース。本物と同じサーバーと Runner を手元の空いた番号で起こし、出来事と SDK の Claude の呼び出しはゲートウェイの開発の道に送る (ログインと記録の 3.9、社員が考えるの 3.2)
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, AppError, type Fetcher, log, systemClock } from "@know-office/core";
import type { Agent } from "./agent.ts";
import { gateReporter } from "./events.ts";
import { GATE_ORIGIN } from "./hooks.ts";
import { Runner } from "./run.ts";
import { sdkAgent } from "./sdk.ts";
import { createWorkspaceServer } from "./server.ts";

/** ゲートウェイの開発の道 (/__dev/workspace/<社員 ID>)。これでない宛先には出来事を送らない */
const LOCAL_GATE = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/__dev\/workspace\/[a-z]+$/;

/** 手元に残す出来事の並びの数。確かめに使うだけなので、増え続けないよう古い物から捨てる */
export const DEV_EVENTS_MAX = 500;

/**
 * 送るはずだった出来事を手元に足し、最後の DEV_EVENTS_MAX 回分だけを残す
 * @param kept 残している物
 * @param sent 送るはずだった出来事
 */
export function rememberEvents<T>(kept: T[][], sent: T[]): void {
  kept.push(sent);
  if (kept.length > DEV_EVENTS_MAX) kept.splice(0, kept.length - DEV_EVENTS_MAX);
}

/** 起こした代わりのワークスペース */
export type DevWorkspace = {
  /** Node のサーバーの番号 */
  port: number;
  /** ゲートウェイへ送った出来事。最後の 500 回分をここにも残す */
  events: AgentEvent[][];
  /** 走っている呼び出しを止めてサーバーを閉じる */
  close(): Promise<void>;
};

/**
 * ゲートウェイ (http://gate.internal/) への要求を、手元のゲートウェイの開発の道に回す fetch を作る。コンテナでは受け手がする事を、ここでは道を書き換えてする
 * @param gateUrl ゲートウェイの開発の道
 * @returns fetch
 */
function devGateFetch(gateUrl: string): Fetcher {
  return (url, init) => {
    if (!url.startsWith(GATE_ORIGIN)) return Promise.reject(new Error("ゲートウェイでない宛先"));
    return fetch(`${gateUrl}/${url.slice(GATE_ORIGIN.length)}`, init);
  };
}

/**
 * 代わりのワークスペースを 127.0.0.1 の空いた番号で起こす。SDK の作業の置き場とホームは一時の置き場に作り、閉じる時に消す
 * SDK はゲートウェイの開発の道の Claude のプロキシ (<gateUrl>/anthropic) を呼ぶ。本物のコンテナと同じく、作業トークンを確かめ、使った量と上限を数えてから代わりの Claude API に回る
 * @param options ゲートウェイの鍵、ゲートウェイの開発の道、呼び出しの代わり
 * @param options.key ゲートウェイの鍵
 * @param options.gateUrl ゲートウェイの開発の道 (http://localhost:<番号>/__dev/workspace/<社員 ID>)
 * @param options.agent SDK の呼び出し。省くと本物の SDK
 * @returns 起こした物
 * @throws internal ゲートウェイの開発の道が手元でない時。ほかの宛先には向けない
 */
export async function startDevWorkspace(options: { key: string; gateUrl: string; agent?: Agent }): Promise<DevWorkspace> {
  if (!LOCAL_GATE.test(options.gateUrl)) throw new AppError("internal", "ゲートウェイの開発の道が手元の宛先でない");
  const events: AgentEvent[][] = [];
  const fetcher = devGateFetch(options.gateUrl);
  const toGate = gateReporter({ fetcher });
  const root = await mkdtemp(join(tmpdir(), "know-office-workspace-"));
  const cwd = join(root, "work");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd), mkdir(home)]);
  const runner = new Runner(
    options.agent ?? sdkAgent(),
    (error) => log("warn", "dev_run_failed", { error: error instanceof Error ? error.name : "unknown" }),
    { fetcher, clock: systemClock, record: (call) => log("warn", "hook_denied", call) },
    undefined,
    {
      report: (ticket, sent) => {
        rememberEvents(events, sent);
        return toGate.report(ticket, sent);
      },
    },
    { baseUrl: `${options.gateUrl}/anthropic`, cwd, home },
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
      await rm(root, { recursive: true, force: true });
    },
  };
}
