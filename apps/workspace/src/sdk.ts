// Claude Agent SDK の query() を呼び、session を知らせ、失敗で終えたら投げる (社員が考えるの 3.1、3.2)
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentOptions } from "./agent.ts";

/** SDK が流す出来事のうち、ワークスペースが見る所 */
export type SdkEvent = {
  /** 出来事の種類。終わりは result */
  type: string;
  /** result の時の終わり方。success のほかは失敗 */
  subtype?: string;
  /** result の時、success でも API の失敗で終えたら true */
  is_error?: boolean;
  /** API の失敗で終えた時の HTTP のステータス */
  api_error_status?: number | null;
  /** success の時の最後の文 */
  result?: string;
  /** assistant と api_retry の時、API の失敗の種類 (authentication_failed など) */
  error?: string;
  /** api_retry の時、失敗した呼び出しの HTTP のステータス */
  error_status?: number | null;
  /** 会話の session */
  session_id?: string;
};

/** SDK の失敗の種類。ゲートウェイのエラーログの名前になる */
export type SdkFailureName = "sdk_auth_failed" | "sdk_failed";

/** SDK の呼び出しの失敗。name で鍵の失敗とほかを分ける。SDK の文は鍵を含みうるので message に入れない */
export class SdkFailure extends Error {
  override readonly name: SdkFailureName;

  /**
   * 失敗を作る
   * @param name 種類
   * @param message 記録に残す短い説明。SDK の文を入れない
   */
  constructor(name: SdkFailureName, message: string) {
    super(message);
    this.name = name;
  }
}

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
    let authFailed = false;
    let text: string | undefined;
    for await (const message of run({ prompt: call.prompt, options: sdkOptions(call.options, spawn) })) {
      if (sessionId === undefined && message.session_id !== undefined) {
        sessionId = message.session_id;
        call.onSession(sessionId);
      }
      call.onEvent();
      // assistant の error は SDK 0.3.325 の SDKAssistantMessageError。鍵が違う時は authentication_failed が付く
      if (message.type === "assistant" && message.error === "authentication_failed") authFailed = true;
      // SDK は鍵の失敗 (401) も数分かけて待ち直す (SDK 0.3.325 の SDKAPIRetryMessage)。鍵は待っても直らないので、1 回目で止めてゲートウェイに伝える
      if (message.type === "system" && message.subtype === "api_retry" && (message.error === "authentication_failed" || message.error_status === 401 || message.error_status === 403)) {
        const failure = new SdkFailure("sdk_auth_failed", `Claude API が ${String(message.error_status ?? 401)} で断った`);
        call.options.abortController.abort(failure);
        throw failure;
      }
      if (message.type !== "result") continue;
      if (message.subtype !== "success") throw new SdkFailure("sdk_failed", `SDK が ${message.subtype ?? "unknown"} で終わった`);
      // SDK 0.3.325 の SDKResultSuccess: is_error が true なら API の失敗で終えた。api_error_status にその時のステータスが入る
      if (message.is_error === true) {
        const status = message.api_error_status ?? null;
        const auth = authFailed || status === 401 || status === 403;
        throw new SdkFailure(auth ? "sdk_auth_failed" : "sdk_failed", `Claude API が ${status === null ? "失敗" : String(status)} で終えた`);
      }
      text = message.result;
    }
    return text;
  };
}
