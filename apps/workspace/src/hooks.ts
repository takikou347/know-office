// ツールを使う前のフック。ゲートウェイのルールの判断を聞き、届かない、遅い、エラーの時は断る (社員が考えるの 3.4)
import { allowedFetch, DecideAnswer, PreToolUseInput, type Clock, type Decision, type Fetcher } from "@know-office/core";

/** ゲートウェイの受け口。ワークスペースの外向きの通信はこの宛先だけに出る */
export const GATE_ORIGIN = "http://gate.internal/";

/** ツールの可否を聞くルート (POST /ws/v1/decisions) */
export const GATE_DECISIONS_URL = `${GATE_ORIGIN}ws/v1/decisions`;

/** ルールの判断を待つ長さ (5 秒)。コード規約の「外を呼ぶ時」 */
export const DECISION_TIMEOUT_MS = 5000;

/** ゲートウェイが判断できずにフックが断った記録。作業トークンと入力は入れない */
export type DeniedCall = {
  /** 断った時刻 (協定世界時のミリ秒) */
  at: number;
  /** ツールの名前 */
  toolName: string;
  /** 断った理由 */
  reason: string;
};

/** フックの依り所 */
export type HookDeps = {
  /** ゲートウェイを呼ぶ関数 */
  fetcher: Fetcher;
  /** 今の作業トークン。チェックポイントで差し替わるので毎回読む */
  token: () => string;
  /** 今の時刻 */
  clock: Clock;
  /** フックが断った記録を残す先 */
  record: (call: DeniedCall) => void;
  /** 待ちの期限の作り方。初期値は AbortSignal.timeout */
  deadline?: (ms: number) => AbortSignal;
};

/** SDK の PreToolUse のフックの返す形 */
export type PreToolUseOutput = {
  /** PreToolUse に固有の答え */
  hookSpecificOutput: {
    /** 答えたフックの出来事 */
    hookEventName: "PreToolUse";
    /** 通すか断るか */
    permissionDecision: "allow" | "deny";
    /** SDK と社員に返す理由 */
    permissionDecisionReason: string;
  };
};

/**
 * ゲートウェイにツールの可否を聞く。答えが無い時は理由を付けて投げる
 * @param deps フックの依り所
 * @param toolName ツールの名前
 * @param toolInput ツールの入力
 * @returns ゲートウェイの判断
 */
async function ask(deps: HookDeps, toolName: string, toolInput: Record<string, unknown>): Promise<Decision> {
  const signal = (deps.deadline ?? ((ms) => AbortSignal.timeout(ms)))(DECISION_TIMEOUT_MS);
  const res = await allowedFetch(deps.fetcher, GATE_DECISIONS_URL, [GATE_ORIGIN], {
    method: "POST",
    headers: { authorization: `Bearer ${deps.token()}`, "content-type": "application/json" },
    body: JSON.stringify({ toolName, toolInput }),
    signal,
  });
  if (!res.ok) throw new Error(`ルールの判断が ${res.status} を返した`);
  const body: unknown = await res.json();
  return DecideAnswer.parse(body).data;
}

/**
 * SDK に返すフックの答えを作る
 * @param allow 通すか
 * @param reason 理由
 * @returns PreToolUse の答え
 */
function out(allow: boolean, reason: string): PreToolUseOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allow ? "allow" : "deny", permissionDecisionReason: reason } };
}

/**
 * SDK の hooks.PreToolUse に渡すフックを作る。ゲートウェイが答えない時は断り、記録を残す
 * @param deps フックの依り所
 * @returns SDK の入力を受けて通すか断るかを返すフック
 */
export function preToolUse(deps: HookDeps): (input: unknown) => Promise<PreToolUseOutput> {
  return async (input) => {
    const parsed = PreToolUseInput.safeParse(input);
    let toolName = "unknown";
    let reason: string;
    if (parsed.success) {
      toolName = parsed.data.tool_name;
      try {
        const decision = await ask(deps, toolName, parsed.data.tool_input);
        // ゲートウェイが判断した時は、通しても断っても tool_calls にゲートウェイが残す
        return out(decision.allow, decision.reason);
      } catch (error) {
        // 届かない、5 秒で答えない、エラー、形が違う時は断る側に倒す
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        reason = timeout ? "ルールの判断が 5 秒で返らないので断る" : "ルールの判断を受けられないので断る";
      }
    } else {
      reason = "フックの入力の形が違うので断る";
    }
    deps.record({ at: deps.clock.now(), toolName, reason });
    return out(false, reason);
  };
}
