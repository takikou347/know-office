// Claude Agent SDK に渡す呼び出しの形と、設定を読ませずにフックを関数で渡す options を作る (社員が考えるの 3.1、3.2)
import { CONTAINER_CA } from "@know-office/core";
import type { PreToolUseOutput } from "./hooks.ts";

/** 社員が書ける唯一の置き場。タスクのリポジトリを置く */
export const WORK_ROOT = "/work";

/** SDK の query() に渡す options のうち、ワークスペースが決める所 */
export type AgentOptions = {
  /** モデル */
  model: string;
  /** 考える深さ */
  effort: "low" | "medium" | "high";
  /** 役目の説明文と組織の決まり */
  systemPrompt: string;
  /** 読む設定の置き場。空にしてリポジトリと利用者の .claude/ を読まない */
  settingSources: [];
  /** 動く置き場 */
  cwd: string;
  /** SDK とそのツールに渡す環境変数 */
  env: { ANTHROPIC_API_KEY: string; HOME: string; PATH: string; NODE_EXTRA_CA_CERTS: string };
  /** ツールを使う前のフック。関数で渡し、ファイルから読まない */
  hooks: { PreToolUse: [{ hooks: [(input: unknown) => Promise<PreToolUseOutput>] }] };
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
};

/** SDK を 1 回呼び、終わるまで待つ。abortController で止めると投げる。本物の SDK は tasks.md の 7.6 でつなぐ */
export type Agent = (call: AgentCall) => Promise<void>;

/**
 * SDK の options を作る。作業トークンを ANTHROPIC_API_KEY に入れ、宛先は変えない。ほかの鍵や環境変数は渡さない
 * @param input 作業トークン、モデル、考える深さ、役目の説明文、フック、止める口、続きの session
 * @param input.ticket 作業トークン
 * @param input.model モデル
 * @param input.effort 考える深さ
 * @param input.systemPrompt 役目の説明文と組織の決まり
 * @param input.hook PreToolUse のフック
 * @param input.abortController 呼び出しを終える口
 * @param input.resume 続きから呼ぶ session
 * @returns SDK の options
 */
export function agentOptions(input: {
  ticket: string;
  model: string;
  effort: "low" | "medium" | "high";
  systemPrompt: string;
  hook: (input: unknown) => Promise<PreToolUseOutput>;
  abortController: AbortController;
  resume?: string | undefined;
}): AgentOptions {
  return {
    model: input.model,
    effort: input.effort,
    systemPrompt: input.systemPrompt,
    settingSources: [],
    cwd: WORK_ROOT,
    env: { ANTHROPIC_API_KEY: input.ticket, HOME: process.env.HOME ?? "/home/staff", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_EXTRA_CA_CERTS: CONTAINER_CA },
    hooks: { PreToolUse: [{ hooks: [input.hook] }] },
    abortController: input.abortController,
    ...(input.resume === undefined ? {} : { resume: input.resume }),
  };
}
