// Claude Agent SDK に渡す呼び出しの形と、設定を読ませずにフックを関数で渡す options を作る (社員が考えるの 3.1、3.2)
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { CONTAINER_CA, HAIKU, type RunInput } from "@know-office/core";
import type { PreToolUseOutput } from "./hooks.ts";

/** 社員が書ける唯一の置き場。タスクのリポジトリを置く */
export const WORK_ROOT = "/work";

/**
 * SDK に渡すホームを返す。SDK は会話の記録をこの下に書く。サーバーは root で動くので、サーバーの HOME は使わない
 * @returns 社員のホーム
 */
export function staffHome(): string {
  return "/home/staff";
}

/** SDK の query() に渡す options のうち、ワークスペースが決める所 */
export type AgentOptions = {
  /** モデル */
  model: string;
  /** 考える深さ */
  effort: RunInput["effort"];
  /** 役目の説明文と組織の決まり */
  systemPrompt: string;
  /** 読む設定の置き場。空にしてリポジトリと利用者の .claude/ を読まない */
  settingSources: [];
  /** 動く置き場 */
  cwd: string;
  /** SDK とそのツールに渡す環境変数。ANTHROPIC_BASE_URL は開発の代わりのワークスペースだけが付ける */
  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
    ANTHROPIC_SMALL_FAST_MODEL: string;
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1";
    HOME: string;
    PATH: string;
    NODE_EXTRA_CA_CERTS: string;
    ANTHROPIC_BASE_URL?: string;
  };
  /** ツールを使う前のフック。関数で渡し、ファイルから読まない */
  hooks: { PreToolUse: [{ hooks: [(input: unknown) => Promise<PreToolUseOutput>] }] };
  /** MCP の受け手。社員のツールの staff だけを渡す */
  mcpServers: { staff: McpSdkServerConfigWithInstance };
  /** 呼び出しを終える口 */
  abortController: AbortController;
  /** 続きから呼ぶ session。無ければ頭から */
  resume?: string;
};

/** SDK の 1 回の呼び出し */
export type AgentCall = {
  /** 最初の指示 */
  prompt: string;
  /** options */
  options: AgentOptions;
  /** SDK が session を決めた時に呼ぶ */
  onSession(sessionId: string): void;
  /** SDK の出来事を 1 つ読むたびに呼ぶ。待たずに返す */
  onEvent(): void;
};

/** SDK を 1 回呼び、終わるまで待つ。終われば最後の文を返す。abortController で止めると投げる。本物は sdk.ts の sdkAgent */
export type Agent = (call: AgentCall) => Promise<string | undefined | void>;

/**
 * SDK の options を作る。作業トークンを ANTHROPIC_API_KEY に入れ、宛先は変えない。ほかの鍵や環境変数は渡さない
 * @param input 作業トークン、モデル、考える深さ、役目の説明文、フック、止める口、続きの session
 * @param input.ticket 作業トークン
 * @param input.model モデル
 * @param input.effort 考える深さ
 * @param input.systemPrompt 役目の説明文と組織の決まり
 * @param input.hook PreToolUse のフック
 * @param input.staff 社員のツールの MCP の受け手
 * @param input.abortController 呼び出しを終える口
 * @param input.resume 続きから呼ぶ session
 * @param input.baseUrl Claude の宛先。開発の代わりのワークスペースだけが渡す
 * @returns SDK の options
 */
export function agentOptions(input: {
  ticket: string;
  model: string;
  effort: RunInput["effort"];
  systemPrompt: string;
  hook: (input: unknown) => Promise<PreToolUseOutput>;
  staff: McpSdkServerConfigWithInstance;
  abortController: AbortController;
  resume?: string | undefined;
  baseUrl?: string | undefined;
}): AgentOptions {
  return {
    model: input.model,
    effort: input.effort,
    systemPrompt: input.systemPrompt,
    settingSources: [],
    cwd: WORK_ROOT,
    env: {
      ANTHROPIC_API_KEY: input.ticket,
      // SDK が裏で呼ぶ軽い呼び出し (題を付けるなど) も、プロキシが許す軽いモデルにする
      ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU,
      ANTHROPIC_SMALL_FAST_MODEL: HAIKU,
      // 更新の確かめや報告など、作業に要らない外への通信をしない
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      HOME: staffHome(),
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      NODE_EXTRA_CA_CERTS: CONTAINER_CA,
      // コンテナでは宛先を変えず、受け手がプロキシに回す。開発の代わりのワークスペースだけが手元の代わりの Claude を渡す
      ...(input.baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: input.baseUrl }),
    },
    hooks: { PreToolUse: [{ hooks: [input.hook] }] },
    mcpServers: { staff: input.staff },
    abortController: input.abortController,
    ...(input.resume === undefined ? {} : { resume: input.resume }),
  };
}
