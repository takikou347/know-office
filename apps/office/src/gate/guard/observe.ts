// ゲートウェイの中のセキュリティに関わる出来事を受け、持ち主の DO で数え、止めるか近かったかを残す (自動停止の 1.2、3.4)
import { AppError, DEFAULT_THRESHOLDS, GuardEvent, isStaffEvent, type Judgment, StaffId, taskOverrun } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { applyStop, askReviewer, guardDo, recordNear, staffOf, type StopInput } from "./actions.ts";
import type { GuardDeps, Observed } from "./deps.ts";
import { loadThresholds, thresholdsHash } from "./thresholds.ts";

/** 基準の最新の行のうち、確かめに使う所 */
const LatestThresholds = z.object({ id: z.string(), value: z.string().nullable(), version: z.number().int(), created_at: z.number() });

/** 基準を変えたルートが監査ログに残す中身のうち、確かめに使う所 */
const ThresholdsAudit = z.object({ version: z.number().int(), hash: z.string() }).loose();

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
  // 基準の行が壊されていても、手順を通らずに変わった基準では全体を止められるよう、初期値で数える
  const { thresholds, version } = await loadThresholds(env.DB).catch((error: unknown) => {
    if (event.type === "threshold_mismatch") return { thresholds: DEFAULT_THRESHOLDS, version: 0 };
    throw error;
  });
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

/**
 * 基準が手順を通って変わったかを確かめる。settings の最新の行のハッシュを、GuardDO が持つハッシュと、その行を入れた監査ログのハッシュと比べ、合わなければ threshold_mismatch で全体を止める。5 分ごとの定期ジョブが呼ぶ
 * @param env バインディング
 * @param now 今の時刻
 * @param deps 外へ頼む口
 */
export async function checkThresholds(env: Bindings, now: number, deps: GuardDeps): Promise<void> {
  if (await thresholdsIntact(env, now)) return;
  await observe(env, { type: "threshold_mismatch" }, now, deps);
}

/** 基準の行を足してから、監査ログと GuardDO に書き終えるのを待つ間。この間は合わなくても止めず、次の回で見る */
export const THRESHOLD_GRACE_MS = 2 * 60_000;

/**
 * 基準の最新の行が、基準を変えるルートで入れた物のままかを返す。読めない、形が違う時は合わない事にする
 * @param env バインディング
 * @param now 今の時刻
 * @returns 合うか、足したばかりで猶予の中なら true
 */
async function thresholdsIntact(env: Bindings, now: number): Promise<boolean> {
  const held = await guardDo(env).thresholdHash();
  const raw = await env.DB.prepare("SELECT id, value, version, created_at FROM settings WHERE key = 'guard.thresholds' ORDER BY version DESC LIMIT 1").first();
  // 一度も変えていない間は、GuardDO がハッシュを持たないか、初期値のハッシュを持つ
  if (raw === null) return held === null || held === (await thresholdsHash(DEFAULT_THRESHOLDS));
  const row = LatestThresholds.safeParse(raw);
  if (!row.success) return false;
  // 基準を変えるルートが監査ログと GuardDO に書く途中なら待つ。先の時刻の行は猶予にしない
  const age = now - row.data.created_at;
  if (age >= 0 && age < THRESHOLD_GRACE_MS) return true;
  if (row.data.value === null || held === null) return false;
  const value = parseJson(row.data.value);
  if (value === undefined) return false;
  const hash = await thresholdsHash(value);
  if (held !== hash) return false;
  // 監査ログは、入れた settings の行を対象にして残っている
  const found = await env.RECORDER.get(env.RECORDER.idFromName("recorder")).find(row.data.created_at, "guard.thresholds", row.data.id);
  const detail = ThresholdsAudit.safeParse(found?.detail ? parseJson(found.detail) : null);
  return detail.success && detail.data.hash === hash && detail.data.version === row.data.version;
}

/**
 * JSON の文を読む
 * @param text JSON の文
 * @returns 読んだ値。読めなければ undefined
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
