// 直した Issue の効き目を確かめる。直した後の 7 日と前の 7 日の回数 (エラー、目安を超えた呼び出し、割引が当たらなかった呼び出し) を比べて Issue に書き、効かなければ戻すタスクを足す (サービスと拡張の 3.7)
import { type Clock, FindingEffect } from "@know-office/core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { findings, nodes } from "../db/main.ts";
import { insertWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { notifyStaff } from "../work/loop.ts";
import { intakeProject, newNodeRow, recordCreated } from "../work/nodes.ts";
import { recordDbs } from "./records.ts";
import { countSignal } from "./slow-cost.ts";
import { type IssueTracker, publicTracker } from "./tracker.ts";

/** 比べる間 */
const WEEK_MS = 7 * 24 * 60 * 60_000;

const Fixed = z.object({ id: z.string(), fingerprint: z.string(), kind: z.enum(["error", "slow", "cost"]), repo: z.string(), issue_number: z.number().int(), fixed_at: z.number() });

/**
 * 直した PR が入って Issue が閉じた事を残す。開いている Issue だけを直した事にする
 * @param env バインディング
 * @param repo リポジトリ
 * @param issueNumber Issue の番号
 * @param at 閉じた時刻
 * @returns 直した事にしたら true
 */
export async function markFixed(env: Bindings, repo: string, issueNumber: number, at: number): Promise<boolean> {
  const moved = await env.DB.prepare("UPDATE findings SET status = 'fixed', fixed_at = ? WHERE repo = ? AND issue_number = ? AND status = 'open'").bind(at, repo, issueNumber).run();
  return moved.meta.changes === 1;
}

/**
 * その原因の回数を、期間にかかる年の記録から数える。エラーは起きた回数、遅い所は目安を超えた呼び出し、無駄な費用は割引が当たらなかった呼び出し
 * @param env バインディング
 * @param row 直した物
 * @param row.kind 原因の種類
 * @param row.fingerprint 指紋
 * @param from 始め
 * @param to 終わり。含まない
 * @returns 回数
 */
async function countFinding(env: Bindings, row: { kind: "error" | "slow" | "cost"; fingerprint: string }, from: number, to: number): Promise<number> {
  if (row.kind !== "error") return countSignal(env, row.kind, row.fingerprint, from, to);
  const fingerprint = row.fingerprint;
  let total = 0;
  for (const db of recordDbs(env, from, to)) {
    const counted = await db.prepare("SELECT count(*) AS n FROM error_events WHERE fingerprint = ? AND at >= ? AND at < ?").bind(fingerprint, from, to).first<{ n: number }>();
    total += counted?.n ?? 0;
  }
  return total;
}

/**
 * 直してから 7 日たった物の効き目を確かめる。読んだ時に fixed のままの物だけを書き、同時に確かめた 2 つの片方だけが Issue に書く。前の回に Issue へ書けなかった物も書き直す
 * @param env バインディング
 * @param issues GitHub の Issue。書く文は伏せてから渡す
 * @param now 今の時刻
 */
export async function checkEffects(env: Bindings, issues: IssueTracker, now: number): Promise<void> {
  const clock: Clock = { now: () => now };
  const tracker = publicTracker(issues);
  // 先に前の回の書き残しを書く。この回に書けなかった物は次の回に回し、同じ回で 2 度試さない
  await renote(env, tracker, now, clock);
  const { results } = await env.DB.prepare("SELECT id, fingerprint, kind, repo, issue_number, fixed_at FROM findings WHERE status = 'fixed' AND fixed_at <= ? ORDER BY id")
    .bind(now - WEEK_MS)
    .all();
  for (const raw of results) {
    const row = Fixed.safeParse(raw);
    if (!row.success) continue;
    try {
      await checkOne(env, tracker, row.data, now);
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: "finding_effect_failed", error }, clock);
    }
  }
}

/**
 * 前の回に Issue へ書けなかった物を、残した効き目で書き直す。比べ直さず、戻すタスクも重ねない。印を付けた方だけが書く
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param now 今の時刻
 * @param clock 失敗を残す時刻
 */
async function renote(env: Bindings, tracker: IssueTracker, now: number, clock: Clock): Promise<void> {
  const { results: unnoted } = await env.DB.prepare(
    "SELECT id, repo, issue_number, status, effect FROM findings WHERE status IN ('verified', 'reverted') AND noted_at IS NULL AND effect IS NOT NULL ORDER BY id",
  ).all();
  for (const raw of unnoted) {
    const row = Unnoted.safeParse(raw);
    if (!row.success) continue;
    try {
      const claimed = await env.DB.prepare("UPDATE findings SET noted_at = ? WHERE id = ? AND noted_at IS NULL").bind(now, row.data.id).run();
      if (claimed.meta.changes !== 1) continue;
      await note(env, tracker, { id: row.data.id, repo: row.data.repo, issueNumber: row.data.issue_number, worked: row.data.status === "verified", effect: row.data.effect }, now);
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: "finding_effect_failed", error }, clock);
    }
  }
}

const Unnoted = z.object({
  id: z.string(),
  repo: z.string(),
  issue_number: z.number().int(),
  status: z.enum(["verified", "reverted"]),
  effect: z
    .string()
    .transform((s): unknown => JSON.parse(s))
    .pipe(FindingEffect),
});

/**
 * 効き目を Issue に書き、効いた物は閉じる。印 (noted_at = now) を持った方だけが呼ぶ。書けなければ印を外し、次の回に書き直させる
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param target 書く物
 * @param target.id findings の ID
 * @param target.repo リポジトリ
 * @param target.issueNumber Issue の番号
 * @param target.worked 効いたか
 * @param target.effect 効き目
 * @param now 今の時刻。印の値
 * @throws Error GitHub に届かない時
 */
async function note(
  env: Bindings,
  tracker: IssueTracker,
  target: { id: string; repo: string; issueNumber: number; worked: boolean; effect: FindingEffect },
  now: number,
): Promise<void> {
  const text = `直す前の 7 日は ${String(target.effect.before)} 回、直した後の 7 日は ${String(target.effect.after)} 回。`;
  try {
    await tracker.comment(target.repo, target.issueNumber, target.worked ? `${text}効いたので閉じる。` : `${text}効かなかったので、直しを戻すタスクを足した。`);
    if (target.worked) await tracker.close(target.repo, target.issueNumber);
  } catch (error) {
    // 書き足しの後に閉じるのが落ちた時も印を外す。次の回は同じ文をもう 1 度書く
    await env.DB.prepare("UPDATE findings SET noted_at = NULL WHERE id = ? AND noted_at = ?").bind(target.id, now).run();
    throw error;
  }
}

/**
 * 1 件の効き目を確かめて書く
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param row 直した物
 * @param now 今の時刻
 */
async function checkOne(env: Bindings, tracker: IssueTracker, row: z.infer<typeof Fixed>, now: number): Promise<void> {
  const effect = FindingEffect.parse({
    before: await countFinding(env, row, row.fixed_at - WEEK_MS, row.fixed_at),
    after: await countFinding(env, row, row.fixed_at, row.fixed_at + WEEK_MS),
  });
  const worked = effect.after === 0 || effect.after < effect.before;
  const actor = { by: "system", now };
  const orm = drizzle(env.DB);
  const stillFixed = and(eq(findings.id, row.id), eq(findings.status, "fixed"));
  const task = worked
    ? null
    : await newNodeRow(
        env,
        {
          kind: "task",
          parentId: (await intakeProject(env, "office", actor)).id,
          scope: "office",
          title: `戻す: #${String(row.issue_number)} の直し`,
          body: `直した後の 7 日の回数が ${String(effect.after)} 回で、直す前の ${String(effect.before)} 回から減らなかった。直した PR を戻す。`,
          taskKind: "fix",
          assignee: "builder",
          repo: row.repo,
          issueNumber: row.issue_number,
          source: `finding:${row.id}`,
        },
        actor,
      );
  // 戻すタスクは状態の更新と同じ 1 回で、読んだ時に fixed のままの時だけ書く
  const update = orm
    .update(findings)
    .set({ status: worked ? "verified" : "reverted", effect, notedAt: now })
    .where(stillFixed)
    .returning({ id: findings.id });
  const results: unknown[] = task
    ? await orm.batch([insertWhen(env.DB, nodes, task, sqlExists(row.id)), update])
    : await orm.batch([update]);
  if (z.array(z.unknown()).parse(results.at(-1)).length === 0) return;
  if (task) {
    await recordCreated(env, task, actor);
    await notifyStaff(env, "builder", now, false);
  }
  await note(env, tracker, { id: row.id, repo: row.repo, issueNumber: row.issue_number, worked, effect }, now);
}

/**
 * findings の行が fixed のままかを確かめる条件を作る
 * @param id findings の ID
 * @returns SQL の条件
 */
function sqlExists(id: string) {
  return sql`EXISTS (SELECT 1 FROM ${findings} WHERE ${findings.id} = ${id} AND ${findings.status} = 'fixed')`;
}
