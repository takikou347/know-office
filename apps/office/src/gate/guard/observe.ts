// ゲートウェイの中のセキュリティに関わる出来事を受け、持ち主の DO で数え、止めるか近かったかを残す (自動停止の 1.2、3.4)
import { AppError, GuardEvent, isStaffEvent, type Judgment, StaffId, taskOverrun } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { applyStop, askReviewer, guardDo, recordNear, staffOf, type StopInput } from "./actions.ts";
import type { GuardDeps, Observed } from "./deps.ts";
import { loadThresholds } from "./thresholds.ts";

/**
 * 出来事を数え、基準に届けば同じ要求の中で止める
 * @param env バインディング
 * @param input GuardEvent
 * @param now 今の時刻
 * @param deps 外へ頼む口
 * @param traceId 要求のトレース ID
 * @returns 数えた答え
 * @throws validation_failed 出来事の形が違う時
 */
export async function observe(env: Bindings, input: unknown, now: number, deps: GuardDeps, traceId?: string): Promise<Judgment> {
  const parsed = GuardEvent.safeParse(input);
  if (!parsed.success) throw new AppError("validation_failed", "出来事の形が違う");
  const event = parsed.data;
  const { thresholds, version } = await loadThresholds(env.DB);
  const observed: Observed = isStaffEvent(event) ? await staffOf(env, event.staffId).observe(event, now, thresholds) : await guardDo(env).observe(event, now, thresholds);
  await settle(env, observed, version, now, deps, traceId);
  return { action: observed.action, scope: observed.scope, target: observed.target, signal: observed.signal, measured: observed.measured, threshold: observed.threshold };
}

/**
 * 数えた答えに従って止めるか、近かったを残す
 * @param env バインディング
 * @param observed 数えた答え
 * @param rulesVersion 基準のバージョン
 * @param now 今の時刻
 * @param deps 外へ頼む口
 * @param traceId 要求のトレース ID
 */
async function settle(env: Bindings, observed: Observed, rulesVersion: number, now: number, deps: GuardDeps, traceId?: string): Promise<void> {
  if (observed.action === "none" || observed.signal === "") return;
  const input: StopInput = {
    scope: observed.scope,
    target: observed.target,
    signal: observed.signal,
    measured: observed.measured,
    threshold: observed.threshold,
    rulesVersion,
    recentOps: observed.recentOps,
    externalSources: observed.externalSources,
    by: "system",
    ...(traceId === undefined ? {} : { traceId }),
  };
  if (observed.action === "near") {
    await recordNear(env, input, now);
    return;
  }
  const stopId = await applyStop(env, input, now, deps);
  if (stopId) await askReviewer(env, stopId, input, now, deps);
}

/**
 * 作業トークンが使えるかを確かめる。発行した先と違うワークスペースから使われたら全体を止める。プロキシのたびに呼ぶ
 * @param env バインディング
 * @param staffId 社員 ID
 * @param jti 作業トークン ID
 * @param workspaceId 使ったワークスペースの ID
 * @param now 今の時刻
 * @param deps 外へ頼む口
 * @throws unauthenticated 失効した、期限切れ、発行した先と違う時
 */
export async function verifyWorkToken(env: Bindings, staffId: StaffId, jti: string, workspaceId: string, now: number, deps: GuardDeps): Promise<void> {
  const check = await staffOf(env, staffId).checkToken(jti, workspaceId, now);
  if (check === "ok") return;
  if (check === "misuse") await observe(env, { type: "ticket_misuse", staffId, jti, workspaceId }, now, deps);
  throw new AppError("unauthenticated", "作業トークンが使えない");
}

/**
 * 社員ごとに、今のタスクの働いた時間を最長と比べ、届いたタスクを止める。5 分ごとの定期ジョブが呼ぶ
 * @param env バインディング
 * @param now 今の時刻
 * @param deps 外へ頼む口
 */
export async function checkOverruns(env: Bindings, now: number, deps: GuardDeps): Promise<void> {
  const { thresholds, version } = await loadThresholds(env.DB);
  for (const id of StaffId.options) {
    const clock = await staffOf(env, id).taskClock(now);
    if (!clock) continue;
    const judgment = taskOverrun(clock.nodeId, clock.activeMs, thresholds);
    if (judgment.action === "stop") await settle(env, { ...judgment, recentOps: [], externalSources: [] }, version, now, deps);
  }
}
