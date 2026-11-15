// 社員のツールの MCP の受け手 staff。社員の役のツールだけを出し、どれもゲートウェイの POST /ws/v1/tools/{toolName} を呼ぶだけ (社員が考えるの 3.5)
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { allowedFetch, type Fetcher, STAFF_TOOL_CATALOG, type StaffToolName, ToolCallAnswer } from "@know-office/core";
import { GATE_ORIGIN } from "./hooks.ts";

/** 社員のツールを呼ぶルートの頭。後ろにツールの名前を付ける */
export const GATE_TOOLS_URL = `${GATE_ORIGIN}ws/v1/tools/`;

/** MCP の受け手の名前。SDK にはツールが mcp__staff__<名前> で届く */
export const STAFF_SERVER = "staff";

/**
 * ゲートウェイの答えを待つ長さ (60 秒)。pr_open と review_submit はゲートウェイの中で GitHub を 10 秒ずつ数回呼ぶので、
 * 外を呼ぶ時の初期値 10 秒では、ゲートウェイが終える前に切ってしまう
 */
export const TOOL_TIMEOUT_MS = 60_000;

/** 受け手の依り所 */
export type StaffToolDeps = {
  /** ゲートウェイを呼ぶ関数 */
  fetcher: Fetcher;
  /** 今の作業トークン。差し替わるので呼ぶたびに読む */
  token: () => string;
  /** 答えを待つ長さ。省くと 60 秒 */
  timeoutMs?: number;
};

/** SDK に返すツールの答え */
type ToolAnswer = { content: { type: "text"; text: string }[]; isError: boolean };

/**
 * SDK に返す答えを作る
 * @param text 社員に返す文
 * @param isError 失敗か
 * @returns ツールの答え
 */
function answer(text: string, isError: boolean): ToolAnswer {
  return { content: [{ type: "text", text }], isError };
}

/**
 * ゲートウェイの断りの返事から、社員に返す文を作る。problem+json の code と detail だけを使う
 * @param res ゲートウェイの返事
 * @returns code: detail の文
 */
async function refusal(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const fields = new Map<string, unknown>(typeof body === "object" && body !== null ? Object.entries(body) : []);
  const code = fields.get("code");
  const detail = fields.get("detail");
  return typeof code === "string" ? `${code}: ${typeof detail === "string" ? detail : ""}` : `ゲートウェイが ${String(res.status)} で断った`;
}

/**
 * ゲートウェイの社員のツールを 1 回呼ぶ。答えが分からない時は送り直さず、社員に状態を確かめさせる
 * @param deps 受け手の依り所
 * @param name ツールの名前
 * @param toolInput ツールの入力
 * @returns SDK に返す答え
 */
async function callGate(deps: StaffToolDeps, name: StaffToolName, toolInput: Record<string, unknown>): Promise<ToolAnswer> {
  let res: Response;
  try {
    res = await allowedFetch(deps.fetcher, `${GATE_TOOLS_URL}${name}`, [GATE_ORIGIN], {
      method: "POST",
      headers: { authorization: `Bearer ${deps.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ toolInput }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOOL_TIMEOUT_MS),
    });
  } catch {
    // ゲートウェイが動かした後に返事だけが届かなかったかもしれないので、送り直さない
    return answer("ゲートウェイの答えが届かず、結果が分からない。タスクと承認の状態を確かめてから呼び直す", true);
  }
  if (!res.ok) return answer(await refusal(res), true);
  const parsed = ToolCallAnswer.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return answer("ゲートウェイの答えの形が違い、結果が分からない。タスクと承認の状態を確かめてから呼び直す", true);
  return answer(parsed.data.data.content, parsed.data.data.isError);
}

/**
 * 社員の役のツールを、SDK のツールの定義に直す
 * @param deps 受け手の依り所
 * @param names 社員の役で使えるツールの名前
 * @returns ツールの定義
 */
export function staffToolDefinitions(deps: StaffToolDeps, names: readonly StaffToolName[]): SdkMcpToolDefinition[] {
  return names.map((name) => {
    const entry = STAFF_TOOL_CATALOG[name];
    return tool(name, entry.description, entry.shape, (args) => callGate(deps, name, args));
  });
}

/**
 * 社員の役のツールを出す MCP の受け手を作る。SDK を呼ぶたびに作る
 * ツールは ToolSearch の後ろに回さない。ToolSearch はルールの判断が知らないツールとして断るので、回すと社員がツールを使えない
 * @param deps 受け手の依り所
 * @param names 社員の役で使えるツールの名前
 * @returns SDK の mcpServers に渡す受け手
 */
export function staffServer(deps: StaffToolDeps, names: readonly StaffToolName[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: STAFF_SERVER, version: "1.0.0", tools: staffToolDefinitions(deps, names), alwaysLoad: true });
}
