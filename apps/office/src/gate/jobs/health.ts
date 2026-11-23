// 5 分ごとの定期ジョブ。部分ごとの稼働を残し、社員 DO の alarm を掛けて持っているタスクの呼び出しを始めさせ、D1 の使った量を見て上限に近い置き場を知らせ、サービスの様子を読み、最長時間を過ぎたタスクを止め、手順を通らずに変わった基準で全体を止め、送ったバッチ処理の結果を入れ、GitHub に写せなかったレビューを写し直し、レビューのタスクの取りこぼしを立て直し、done のまま残った main への入れ漏れを拾う (社員と勤怠の 3.2、ログインと記録の 3.5、自動停止の 3.1、サービスと拡張の 3.6、タスクとレビューの 3.2)
import { type Clock, newId } from "@know-office/core";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { notices } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { SHARED_TOKENS } from "../github/app.ts";
import { vaultForge } from "../github/vault-forge.ts";
import { retryMirrors } from "../github/mirror.ts";
import { resumeMerges } from "../work/merge-resume.ts";
import { recheckReviews } from "../work/review.ts";
import { settleReleases } from "../devloop/release.ts";
import { connectRollback, type GuardDeps, UNCONNECTED_DEPS } from "../guard/deps.ts";
import { connectReview } from "../guard/review.ts";
import { cloudflareAnalytics } from "../services/analytics.ts";
import { collectMetrics } from "../services/deploys.ts";
import { checkOverruns, checkThresholds } from "../guard/observe.ts";
import { recordError } from "../ledger/errors.ts";
import { announceNotice } from "../live/publish.ts";
import { STORAGE_LIMIT_BYTES, storageUses } from "../ledger/storage.ts";
import { checkHealth } from "../ledger/uptime.ts";
import { pollBatches, type WeeklyDeps } from "./weekly.ts";
import { activeStaff } from "../work/roster.ts";

/** 上限に対してこの割合に届いたら通知を出す */
const WARN_RATIO = 0.8;
const GB = 1000 ** 3;

/**
 * 置き場の通知の題を作る
 * @param binding 置き場の名前
 * @returns 通知の題
 */
function storageTitle(binding: string): string {
  // 題は、同じ置き場の通知を重ねないための鍵も兼ねる。文を変える時はここだけを変える
  return `記録の置き場 ${binding} が上限の ${String(Math.round(WARN_RATIO * 10))} 割に届いた`;
}

/**
 * 上限の 8 割に届いた置き場があれば通知を出す。同じ置き場の通知は、オーナーが読むまで重ねて出さない
 * @param env バインディング
 * @param clock 時刻
 */
export async function checkStorage(env: Bindings, clock: Clock): Promise<void> {
  const orm = drizzle(env.DB);
  for (const use of await storageUses(env)) {
    if (use.ratio < WARN_RATIO) continue;
    const title = storageTitle(use.binding);
    const [open] = await orm
      .select({ id: notices.id })
      .from(notices)
      .where(and(eq(notices.kind, "storage"), eq(notices.title, title), isNull(notices.readAt)))
      .limit(1);
    if (open) continue;
    const id = newId(clock);
    await orm.insert(notices).values({
      id,
      at: clock.now(),
      level: "warn",
      kind: "storage",
      title,
      body: `${(use.bytes / GB).toFixed(1)}GB / ${String(STORAGE_LIMIT_BYTES / GB)}GB を使っている`,
      scope: "office",
    });
    await announceNotice(env, id, clock);
  }
}

/**
 * 定期ジョブを走らせる。社員ごとの arm、置き場、最長時間、基準を見る。失敗は投げずにエラーログに残し、次の 5 分でまた試す
 * @param env バインディング
 * @param ctx 返事の後も処理を続けさせる waitUntil
 * @param ctx.waitUntil 待たせる Promise を渡す
 * @param clock 時刻
 * @param weekly 週のバッチ処理が外へ頼む口。渡した時は、送ったバッチの終わりを見て結果を入れ、その fetch で GitHub に写し直す
 */
export function runScheduled(env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }, clock: Clock, weekly?: WeeklyDeps): void {
  // タスクを止めた時はレビュー担当のモデルに聞く。定期ジョブは全体を waitUntil に渡しているので、その場で待つ
  const reviewed: GuardDeps = { ...UNCONNECTED_DEPS, review: connectReview(env, weekly?.fetch ?? ((input, init) => fetch(input, init)), clock) };
  // 新しい社員 DO は誰かが呼ぶまで alarm を持たず、9 時に出勤しない。プレビューは社員を働かせない (Claude を呼ばない)
  if (env.ENVIRONMENT !== "preview") {
    const arm = async () => {
      for (const { id } of await activeStaff(env.DB)) {
        await env.STAFF.get(env.STAFF.idFromName(id))
          .arm(clock.now())
          .catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "staff_arm_failed", error }, clock));
      }
    };
    ctx.waitUntil(arm().catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "staff_arm_failed", error }, clock)));
  }
  if (weekly) {
    const forge = vaultForge(env, { fetcher: weekly.fetch, clock, cache: SHARED_TOKENS });
    ctx.waitUntil(pollBatches(env, weekly, clock.now()).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "batch_poll_failed", error }, clock)));
    ctx.waitUntil(retryMirrors(env, forge, clock).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "mirror_retry_failed", error }, clock)));
    ctx.waitUntil(settleReleases(env, forge.issues, clock.now()).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "release_settle_failed", error }, clock)));
    // done のまま main に入らずに残ったタスクを、入れ直すか review に戻す。1 回に 20 件まで
    ctx.waitUntil(resumeMerges(env, forge, reviewed, clock.now()).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "merge_resume_failed", error }, clock)));
    // サービスの様子を読み、デプロイの後の失敗で止めた時は rollback.yml で戻す。Cloudflare の Analytics の鍵が無い間は何も読まず、何も書かない
    const deps = { ...UNCONNECTED_DEPS, rollback: connectRollback(env, forge, () => clock.now()) };
    ctx.waitUntil(collectMetrics(env, cloudflareAnalytics(env, weekly.fetch), clock.now(), deps).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "service_metrics_failed", error }, clock)));
  }
  // 部分ごとに通るかを残し、月の稼働率のもとにする。書けない時は checkHealth がエラーログに残す
  ctx.waitUntil(checkHealth(env, clock));
  ctx.waitUntil(
    checkStorage(env, clock).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "storage_check_failed", error }, clock)),
  );
  // レビューのタスクの無いままレビューを待つタスクに、レビューのタスクを立て直す。書く順の間を拾わないよう 10 分の猶予を置く
  ctx.waitUntil(recheckReviews(env, clock.now()).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "review_recheck_failed", error }, clock)));
  // 1 つのタスクの最長時間は 5 分ごとに見る。最長の 4 時間に比べて十分に細かい
  ctx.waitUntil(
    checkOverruns(env, clock.now(), reviewed).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "overrun_check_failed", error }, clock)),
  );
  // 手順を通らずに変わった基準は、5 分のうちに見つけて全体を止める
  ctx.waitUntil(
    checkThresholds(env, clock.now(), UNCONNECTED_DEPS).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "threshold_check_failed", error }, clock)),
  );
}
