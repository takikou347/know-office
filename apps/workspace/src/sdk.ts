// Claude Agent SDK の query() を呼び、session を知らせ、失敗で終えたら投げる (社員が考えるの 3.1、3.2)
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentOptions } from "./agent.ts";

/** SDK が流す出来事のうち、ワークスペースが見る所 */
export type SdkEvent = {
  /** 出来事の種類。終わりは result */
  type: string;
  /** result の時の終わり方。success のほかは失敗 */
  subtype?: string;
  /** 会話の session */
  session_id?: string;
};

/** SDK の query() と同じ形の関数。テストは手元の代わりの Claude API に向けた物を渡す */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SdkEvent>;

/**
 * ワークスペースが決めた options を SDK の形に直す
 * 権限は dontAsk にし、フックが通したツールのほかは断る。設定の置き場は読まない
 * @param options ワークスペースが決めた options
 * @param spawn 子のプロセスを起こす関数。本番は staff に落とす staffSpawner。省くと SDK の既定
 * @returns SDK の options
 */
export function sdkOptions(options: AgentOptions, spawn?: Options["spawnClaudeCodeProcess"]): Options {
  return {
    model: options.model,
    effort: options.effort,
    systemPrompt: options.systemPrompt,
    settingSources: options.settingSources,
    cwd: options.cwd,
    // env は SDK の子のプロセスの環境変数を置き換える。process.env は受け継がない
    env: options.env,
    hooks: options.hooks,
    // MCP の受け手は渡した物だけを使い、置き場や利用者の MCP の設定を読まない
    mcpServers: options.mcpServers,
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    abortController: options.abortController,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(spawn === undefined ? {} : { spawnClaudeCodeProcess: spawn }),
  };
}

/**
 * SDK を 1 回呼んで終わるまで待つ Agent を作る
 * @param run SDK の query()。省くと本物を使う
 * @param spawn 子のプロセスを起こす関数。省くと SDK の既定
 * @returns Agent
 */
export function sdkAgent(run: QueryFn = query, spawn?: Options["spawnClaudeCodeProcess"]): Agent {
  return async (call) => {
    let sessionId: string | undefined;
    for await (const message of run({ prompt: call.prompt, options: sdkOptions(call.options, spawn) })) {
      if (sessionId === undefined && message.session_id !== undefined) {
        sessionId = message.session_id;
        call.onSession(sessionId);
      }
      call.onEvent();
      if (message.type === "result" && message.subtype !== "success") throw new Error(`SDK が ${message.subtype ?? "unknown"} で終わった`);
    }
  };
}
