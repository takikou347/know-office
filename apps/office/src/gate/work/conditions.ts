// main に入れる条件とデプロイの条件に共通の確かめ。承認とチェックがそろったかを、条件の並びと照らす (タスクとレビューの 3.4、サービスと拡張の 3.1)
import { missingConditions, type ReleaseCondition } from "@know-office/core";
import type { Forge } from "./loop.ts";

/** 条件の確かめの答え。waiting は足りない条件、failed は要るチェックが落ちた事 (missing はチェックのほかに足りない条件で、all を付けた時だけ入る) */
export type ConditionCheck = { kind: "met" } | { kind: "waiting"; missing: ReleaseCondition[] } | { kind: "failed"; missing: ReleaseCondition[] };

/**
 * 条件がそろったかを確かめる。承認 (レビュー担当とオーナー) が足りない間は GitHub にチェックを聞かず、チェックが分からない時 (終わっていない、読めない形) は満たしていないとする
 * @param forge GitHub のチェックを読む口
 * @param when 条件
 * @param target チェックを読むリポジトリとコミット
 * @param target.repo リポジトリ
 * @param target.sha 確かめたコミット
 * @param approvals 承認したか。checks は GitHub から読むので持たない
 * @param approvals.reviewer レビュー担当が承認しているか
 * @param approvals.owner オーナーが承認しているか
 * @param options 足りない条件を全部返したい時 (オーナーに出す時) は all を true にする。承認が足りなくてもチェックを読む
 * @param options.all 足りない条件を全部返すか
 * @returns そろったか、足りない条件か、チェックが落ちたか
 * @throws upstream_failed チェックを GitHub から読めない時
 */
export async function checkConditions(
  forge: Pick<Forge, "checkState">,
  when: readonly ReleaseCondition[],
  target: { repo: string; sha: string },
  approvals: { reviewer: boolean; owner: boolean },
  options: { all?: boolean } = {},
): Promise<ConditionCheck> {
  const others = missingConditions(when, { checks: true, ...approvals });
  if (others.length > 0 && options.all !== true) return { kind: "waiting", missing: others };
  const checks = when.includes("checks") ? await forge.checkState(target.repo, target.sha) : "passed";
  if (checks === "failed") return { kind: "failed", missing: others };
  const missing = missingConditions(when, { checks: checks === "passed", ...approvals });
  return missing.length > 0 ? { kind: "waiting", missing } : { kind: "met" };
}
