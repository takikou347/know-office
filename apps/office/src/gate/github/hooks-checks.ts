// チェックの通知 (check_run と check_suite) を受ける。結果をレビューに写し、終わりの通知では承認の後にチェックを待つタスクを main に入れる (タスクとレビューの 3.1 の 5、GitHub の連携の 3.4)
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { CheckRunEvent, CheckSuiteEvent } from "@know-office/core";
import type { Bindings } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import type { Forge } from "../work/loop.ts";
import { mergeAfterChecks } from "../work/merge-checks.ts";

/** 通ったとみなすチェックの結果 */
const PASSED = new Set(["success", "neutral", "skipped"]);

/** チェックの通知のうち使う所 */
export type CheckHook = { event: string; action: string | null; repo: string | null; payload: unknown; digest: string };

/**
 * チェックの通知で直す文を作る。同じ本文の通知をまだ受けていない時だけ書く (fresh)
 * @param db 今の状態の D1
 * @param hook 確かめた通知
 * @param fresh 同じ本文の通知を受けていない条件。? に本文の SHA-256 を当てる
 * @returns 直す文。チェックの通知でなければ null
 */
export function checkChanges(db: D1Database, hook: CheckHook, fresh: string): D1PreparedStatement[] | null {
  if (hook.event === "check_run" && hook.repo !== null) {
    const run = CheckRunEvent.safeParse(hook.payload);
    if (!run.success) return [];
    const { name, status, conclusion, head_sha: sha } = run.data.check_run;
    const ok = status === "completed" && conclusion !== null && PASSED.has(conclusion);
    // 同じ名前の結果を置き換え、名前の順に並べる。読んで書き直さず 1 文で直し、同時に届いた 2 つの片方を消さない
    return [
      db
        .prepare(
          `UPDATE reviews SET checks = (SELECT json_group_array(json(v)) FROM (SELECT v FROM (SELECT value AS v FROM json_each(COALESCE(reviews.checks, '[]')) WHERE json_extract(value, '$.name') <> ? UNION ALL SELECT json_object('name', ?, 'ok', json(?)) AS v) ORDER BY json_extract(v, '$.name'))) WHERE repo = ? AND head_sha = ? AND ${fresh}`,
        )
        .bind(name, name, ok ? "true" : "false", hook.repo, sha, hook.digest),
    ];
  }
  if (hook.event === "check_suite" && hook.repo !== null && (hook.action === "requested" || hook.action === "rerequested")) {
    const suite = CheckSuiteEvent.safeParse(hook.payload);
    if (!suite.success) return [];
    return [db.prepare(`UPDATE reviews SET checks = '[]' WHERE repo = ? AND head_sha = ? AND ${fresh}`).bind(hook.repo, suite.data.check_suite.head_sha, hook.digest)];
  }
  return null;
}

/**
 * 終わりの通知の先を読む。check_run と check_suite の completed だけ (GitHub の Webhook events and payloads の check_run と check_suite)
 * @param hook 確かめた通知
 * @returns リポジトリと先。終わりの通知でなければ null
 */
function completedHead(hook: CheckHook): { repo: string; sha: string } | null {
  if (hook.repo === null || hook.action !== "completed") return null;
  if (hook.event === "check_run") {
    const run = CheckRunEvent.safeParse(hook.payload);
    return run.success ? { repo: hook.repo, sha: run.data.check_run.head_sha } : null;
  }
  if (hook.event === "check_suite") {
    const suite = CheckSuiteEvent.safeParse(hook.payload);
    return suite.success ? { repo: hook.repo, sha: suite.data.check_suite.head_sha } : null;
  }
  return null;
}

/**
 * 受けた記録を書けた終わりの通知の後に、その先を確かめた承認のある review のタスクを main に入れる。落ちても投げずにエラーログに残す。GitHub は送り直さないので、取りこぼしは定期の拾い直しが拾う
 * @param env バインディング
 * @param ctx GitHub を呼ぶ口と、自動停止が外へ頼む口
 * @param ctx.forge GitHub を呼ぶ口
 * @param ctx.guard 自動停止が外へ頼む口
 * @param hook 確かめた通知
 * @param now 受けた時刻
 */
export async function afterChecks(env: Bindings, ctx: { forge: Forge; guard: GuardDeps }, hook: CheckHook, now: number): Promise<void> {
  const head = completedHead(hook);
  if (head === null) return;
  await mergeAfterChecks(env, ctx.forge, ctx.guard, head, now).catch((error: unknown) => recordError(env, { source: "gate", level: "warn", code: "merge_after_checks_failed", error }, clockAt(now)));
}
