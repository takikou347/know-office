// ワークスペースのフックが聞くルールの判断 (POST /ws/v1/decisions)。core の decide() で決め、tool_calls と自動停止に渡す (社員が考えるの 3.5)
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  DecideInput,
  Decision,
  DEFAULT_RULES,
  decide,
  INHERITED_SETTINGS,
  MAX_RECORDED,
  type Judgment,
  newId,
  type Operation,
  type RuleContext,
  type RuleDecision,
  recordedText,
  ROLE_TOOLS,
  type StaffId,
  toOperation,
} from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { toolCalls } from "../db/records.ts";
import type { Bindings, GateEnv } from "../env.ts";
import type { ExtensionDefinition } from "../extensions/define.ts";
import { enabledExtensions } from "../extensions/state.ts";
import { ensureRunning, staffOf } from "../guard/actions.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { loadOfficeDefaults, serviceRules } from "../services/settings.ts";
import { clockAt } from "./attendance.ts";
import { findNode, recordsOf } from "./nodes.ts";
import { bearer, type Caller, ticketTask } from "./ticket.ts";

const decideRoute = createRoute({
  method: "post",
  path: "/ws/v1/decisions",
  operationId: "decideTool",
  tags: ["workspace-gate"],
  summary: "ツールを使ってよいかを問い合わせる",
  description: "フックが 5 秒のタイムアウト付きで呼ぶ。",
  "x-steps": [
    "作業トークンを検証し、社員とタスクを読む",
    "全体、社員、タスクのどれかが止まっていれば 409 `stopped`",
    "タスクの範囲の触れない所を、サービスの設定か office の初期値から読み、`toOperation()` と `decide()` で可否を判断する。外部の文章の印は `owner_info.read` の時だけ `StaffDO.externalSources()` で読む",
    "`guard.observe` に `tool_call` を渡す。`secret.read` と `owner_info.read` は `sensitive_access` を、印を付ける時は `external_read` を渡す。相手は鍵の形を伏せ、500 字で切る",
    "拒否した場合は `guard.observe` に `rule_denied` を渡す。4 で社員を止めた時は渡さない",
    "4 で止めた時は、通す判断でも `{ allow: false, reason: \"止めた\" }` を返す",
    "`tool_calls` に返す答えで追加する。追加に失敗して 500 を返しても、4 と 5 の数えは残る",
  ],
  "x-errors": ["409 `stopped`: 社員かタスクが停止中"],
  security: [{ workToken: [] }],
  request: { body: { content: { "application/json": { schema: DecideInput } }, required: true } },
  responses: { 200: okResponse(Decision), ...problems(400, 401, 403, 409, 413, 415, 422, 500) },
});

/**
 * タスクの範囲の触れない所を読む。サービスのタスクはサービスの設定、ほかは office の初期値を使い、判断のたびに読む
 * @param env バインディング
 * @param scope タスクの範囲 (office かサービスの ID)
 * @returns 触れない所
 */
async function protectedPathsOf(env: Bindings, scope: string): Promise<string[]> {
  if (scope !== "office") return (await serviceRules(env.DB, scope)).protectedPaths;
  return INHERITED_SETTINGS.protectedPaths.parse((await loadOfficeDefaults(env.DB)).protectedPaths.value);
}

/**
 * ルールの判断の前提を作る。触れない所、外部の文章の印、入れている拡張のツール、社員の役で使える社員のツールを判断のたびに読む
 * @param env バインディング
 * @param who 社員とタスク
 * @param who.staffId 社員 ID
 * @param who.nodeId タスク ID
 * @param who.scope タスクの範囲
 * @param op 判断する操作
 * @param extensions 読み込んだ拡張
 * @returns 判断の前提
 */
export async function ruleContext(env: Bindings, who: { staffId: StaffId; nodeId: string; scope: string }, op: Operation, extensions: readonly ExtensionDefinition[]): Promise<RuleContext> {
  return {
    ...DEFAULT_RULES,
    officeTools: ROLE_TOOLS[who.staffId],
    protectedPaths: await protectedPathsOf(env, who.scope),
    // 外部の文章の印はオーナーの情報の判断だけが見るので、その時だけ社員 DO に聞く
    external: op.kind === "owner_info.read" && (await staffOf(env, who.staffId).externalSources(who.nodeId)).length > 0,
    // 拡張のツールは、判断のたびに設定で入れている拡張から読む
    extensionTools: op.kind === "ext.tool" ? (await enabledExtensions(env.DB, extensions)).flatMap((e) => Object.keys(e.tools).map((t) => `${e.id}.${t}`)) : [],
  };
}

/** 観察が止めた時に返す答え。ルールが通す判断でも断る */
const STOPPED: Decision = { allow: false, reason: "止めた" };

/**
 * 判断を自動停止に渡して数える。鍵とオーナーの情報への試みは、タスクを止める rule_denied より先に渡す。先にタスクを止めると外部の文章の印が消え、持ち出しを見逃す
 * @param env バインディング
 * @param input 社員、タスク、操作、判断、記録に残す相手
 * @param input.staffId 社員 ID
 * @param input.nodeId タスク ID
 * @param input.op 操作
 * @param input.decision ルールの判断
 * @param input.target 鍵を伏せて切った相手
 * @param now 今の時刻
 * @param deps 自動停止が外へ頼む口
 * @param traceId 要求のトレース ID
 * @returns rule_denied より前の出来事で止めたか
 */
async function count(
  env: Bindings,
  input: { staffId: StaffId; nodeId: string; op: Operation; decision: RuleDecision; target: string },
  now: number,
  deps: GuardDeps,
  traceId: string,
): Promise<boolean> {
  const { staffId, nodeId, op, decision, target } = input;
  const judgments: Judgment[] = [await observe(env, { type: "tool_call", staffId }, now, deps, traceId)];
  if (op.kind === "secret.read" || op.kind === "owner_info.read") judgments.push(await observe(env, { type: "sensitive_access", staffId, nodeId, item: target }, now, deps, traceId));
  if (decision.marksExternal) judgments.push(await observe(env, { type: "external_read", staffId, nodeId, source: target }, now, deps, traceId));
  const stopping = judgments.filter((j) => j.action === "stop");
  // 社員ごと止めた後は、そのタスクを重ねて止めない
  if (!decision.allow && !stopping.some((j) => j.scope === "staff")) await observe(env, { type: "rule_denied", staffId, nodeId, operation: op.kind, target }, now, deps, traceId);
  return stopping.length > 0;
}

/**
 * ワークスペースの受け手に、ルールの判断のルートを足す
 * @param app 送ったワークスペースを結んだ受け手の Hono
 * @param caller 送ったワークスペース
 * @param extensions 読み込んだ拡張
 */
export function decisionRoutes(app: OpenAPIHono<GateEnv>, caller: Caller, extensions: readonly ExtensionDefinition[]): void {
  app.openapi(decideRoute, async (c) => {
    const input = c.req.valid("json");
    const now = c.var.clock.now();
    const { staffId, nodeId } = await ticketTask(c.env, bearer(c.req.header("authorization")), caller, now);
    await ensureRunning(c.env, staffId, nodeId);
    const node = await findNode(c.env.DB, nodeId);
    const op = toOperation(input.toolName, input.toolInput);
    const decision = decide(op, await ruleContext(c.env, { staffId, nodeId, scope: node.scope }, op, extensions));
    const target = recordedText(op.target);
    // 数えは記録より先に渡す。tool_calls に書けずに 500 を返しても、自動停止の数えには入る
    const answer: Decision = (await count(c.env, { staffId, nodeId, op, decision, target }, now, c.var.guard, c.var.traceId)) ? STOPPED : { allow: decision.allow, reason: decision.reason };
    await drizzle(recordsOf(c.env, now))
      .insert(toolCalls)
      .values({
        id: newId(clockAt(now)),
        at: now,
        staffId,
        nodeId,
        scope: node.scope,
        // tool は SDK が決めたツールの名前で鍵を入れる所ではなく、知らないツールを断った跡を名前のまま残すため伏せない (長さだけ切る)
        tool: Array.from(input.toolName).slice(0, MAX_RECORDED).join(""),
        opKind: op.kind,
        target,
        allowed: answer.allow,
        reason: answer.reason,
        ms: c.var.clock.now() - now,
        traceId: c.var.traceId,
      });
    return ok(c, answer);
  });
}
