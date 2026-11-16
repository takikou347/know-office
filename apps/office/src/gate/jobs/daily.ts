// 毎日 0 時 5 分の定期ジョブ。前の日の日ごとの集計を、社員 DO を通して作り直し、全部の年の監査ログのつなぎを確かめ、直した Issue の効き目を確かめる (社員と勤怠の 3.6、ログインと記録の 3.4、サービスと拡張の 3.7)
import { type Clock, jstDay, jstDayStart, jstYear, newId, StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { checkEffects } from "../findings/effect.ts";
import { fingerprintMark, type IssueTracker, publicTracker, REPO_PATTERN } from "../findings/tracker.ts";
import { announceNotice } from "../live/publish.ts";
import { type GuardDeps, UNCONNECTED_DEPS } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { recordError } from "../ledger/errors.ts";
import type { WeeklyDeps } from "./weekly.ts";

/** 日本時間の 0 時 5 分。Cron は協定世界時で書くので 15 時 5 分になる。wrangler.jsonc の triggers.crons に同じ文字列を置く */
export const DAILY_CRON = "5 15 * * *";

/**
 * 前の日の集計を、社員ごとに社員 DO の鎖で作り直す。区分を書いている途中の DO と食い違わないよう、D1 を直に書かない
 * @param env バインディング
 * @param clock 時刻
 * @returns 無し
 */
export async function rebuildYesterday(env: Bindings, clock: Clock): Promise<void> {
  const now = clock.now();
  const yesterday = jstDay(jstDayStart(jstDay(now)) - 1);
  await Promise.all(StaffId.options.map((id) => env.STAFF.get(env.STAFF.idFromName(id)).rebuildDay(yesterday, now)));
}

/**
 * record_years の全部の年のハッシュチェーンを記録 DO で頭から確かめ、確かめ直しても合わない年があれば確かな不正として全体を止める
 * 記録 DO の verify は確かめ始めた時の最後の行までを読み、行は 1 文で前のハッシュと一緒に書くので、書いている途中の行を合わないと見ない
 * 記録 DO に届かない年は止めずにエラーログに残し、ほかの年を確かめ続ける。次の日にまた確かめる
 * @param env バインディング
 * @param clock 時刻
 * @param deps 自動停止が外へ頼む口
 */
export async function verifyChains(env: Bindings, clock: Clock, deps: GuardDeps): Promise<void> {
  const { results } = await env.DB.prepare("SELECT year FROM record_years ORDER BY year").all<{ year: number }>();
  const recorder = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
  const verify = (year: number) =>
    recorder.verify(year).catch(async (error: unknown) => {
      await recordError(env, { source: "job", level: "error", code: "chain_verify_failed", error }, clock);
      return null;
    });
  for (const { year } of results) {
    const check = await verify(year);
    if (!check || check.ok) continue;
    // 猶予: 全体を止める前にもう 1 度頭から確かめ、2 度とも合わない時だけ止める。読み違いや途中の書き込みで誤って止めない
    const again = await verify(year);
    if (again && !again.ok) await observe(env, { type: "chain_broken", year }, clock.now(), deps);
  }
}

/** 5 年先の置き場を確かめる日 (日本時間の月と日) */
const YEAR_CHECK_DAY = "-12-01";

/** 先に結んでおく年の数 */
const YEARS_AHEAD = 5;

/**
 * 文の SHA-256 を 16 進数で返す。Issue の本文に隠す指紋にする
 * @param text 文
 * @returns 64 桁の 16 進数
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 日本時間の 12 月 1 日に、5 年先の年の記録の置き場 (REC_<年>) が結ばれているかを確かめる。無ければ置き場の通知を出し、OFFICE_REPO があれば Issue を作る
 * 通知はオーナーが読むまで重ねず、Issue は本文に隠した指紋で探して 2 つ作らない。Issue を作れない時はエラーログに残し、通知は出す
 * @param env バインディング
 * @param tracker GitHub の Issue の口
 * @param clock 時刻
 */
export async function checkFutureYears(env: Bindings, tracker: IssueTracker, clock: Clock): Promise<void> {
  const now = clock.now();
  if (!jstDay(now).endsWith(YEAR_CHECK_DAY)) return;
  const binding = `REC_${String(jstYear(now) + YEARS_AHEAD)}`;
  // 5 年先は RECORD_BINDINGS より先の年にもなるので、名前で env を引く
  if (Reflect.get(env, binding) !== undefined) return;
  const title = `記録の置き場 ${binding} がまだ結ばれていない`;
  const body = `${binding} の D1 を作り、wrangler.jsonc の d1_databases と RECORD_BINDINGS に足す。年をまたぐ前に結ぶ (ログインと記録の 3.5)`;
  const open = await env.DB.prepare("SELECT 1 FROM notices WHERE kind = 'storage' AND title = ? AND read_at IS NULL LIMIT 1").bind(title).first();
  if (!open) {
    const id = newId(clock);
    await env.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES (?, ?, 'warn', 'storage', ?, ?, 'office')").bind(id, now, title, body).run();
    await announceNotice(env, id, clock);
  }
  const repo = env.OFFICE_REPO ?? "";
  if (!REPO_PATTERN.test(repo)) return;
  try {
    const fingerprint = await sha256Hex(`record_year:${binding}`);
    const issues = publicTracker(tracker);
    if ((await issues.findIssue(repo, fingerprint)) === null) await issues.createIssue(repo, { title, body: `${body}\n\n${fingerprintMark(fingerprint)}` });
  } catch (error) {
    await recordError(env, { source: "job", level: "error", code: "record_year_issue_failed", error }, clock);
  }
}

/**
 * 0 時 5 分の定期ジョブを走らせる。失敗は投げずにエラーログに残す。次の日の 0 時 5 分か、出勤や訂正でまた作り直す
 * 週のバッチ処理の口を渡した時は、直してから 7 日たった Issue の効き目も確かめる (サービスと拡張の 3.7)
 * @param env バインディング
 * @param ctx 返事の後も処理を続けさせる waitUntil
 * @param ctx.waitUntil 待たせる Promise を渡す
 * @param clock 時刻
 * @param weekly 週のバッチ処理が外へ頼む口
 */
export function runDaily(env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }, clock: Clock, weekly?: WeeklyDeps): void {
  ctx.waitUntil(
    rebuildYesterday(env, clock).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "daily_totals_rebuild_failed", error }, clock)),
  );
  // 書き換えは監査ログを読んだ時だけでなく、毎日 1 度は全部の年で確かめる
  ctx.waitUntil(verifyChains(env, clock, UNCONNECTED_DEPS).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "chain_verify_failed", error }, clock)));
  if (weekly) {
    ctx.waitUntil(
      checkFutureYears(env, weekly.tracker, clock).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "record_year_check_failed", error }, clock)),
    );
    ctx.waitUntil(checkEffects(env, weekly.tracker, clock.now()).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "finding_effect_failed", error }, clock)));
  }
}
