// pr_open と docs_pr_open が出す前に断る時、ルールの外の操作として数える記録 (自動停止の 1 章)
import { AppError, recordedText, type StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { type GuardDeps, UNCONNECTED_DEPS } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";

/** pr_open か docs_pr_open を呼んだ社員と時刻 */
export type PrCall = { staffId: StaffId; now: number; traceId?: string | undefined; guard?: GuardDeps | undefined };

/**
 * ルールの外の操作として数え、rule_denied で断る。触れない所に当たった時は、そのファイルへの書き込みとして数える
 * @param env バインディング
 * @param call 呼んだ社員と時刻
 * @param task タスクの ID とリポジトリ
 * @param task.id タスク ID
 * @param refusal 断る理由と当たった道
 * @param refusal.reason 理由
 * @param refusal.path 当たった道
 * @param repo 操作したリポジトリ
 * @throws rule_denied 常に
 */
export async function denyByRule(env: Bindings, call: PrCall, task: { id: string }, refusal: { reason: string; path?: string | undefined }, repo: string): Promise<never> {
  const op = refusal.path === undefined ? { operation: "office.tool" as const, target: `${repo} pull_request` } : { operation: "file.write" as const, target: `${repo}/${refusal.path}` };
  await observe(env, { type: "rule_denied", staffId: call.staffId, nodeId: task.id, operation: op.operation, target: recordedText(op.target) }, call.now, call.guard ?? UNCONNECTED_DEPS, call.traceId);
  throw new AppError("rule_denied", refusal.reason);
}
