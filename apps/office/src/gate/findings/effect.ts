// 直した Issue の効き目を確かめる。直した後の 7 日と前の 7 日のエラーの回数を比べて Issue に書き、効かなければ戻すタスクを足す (サービスと拡張の 3.7)
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
import { recordDbs } from "./scan.ts";
import type { IssueTracker } from "./tracker.ts";

/** 比べる間 */
const WEEK_MS = 7 * 24 * 60 * 60_000;

const Fixed = z.object({ id: z.string(), fingerprint: z.string(), repo: z.string(), issue_number: z.number().int(), fixed_at: z.number() });

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
 * その指紋のエラーを、期間にかかる年の記録から数える
 * @param env バインディング
 * @param fingerprint 指紋
 * @param from 始め
 * @param to 終わり。含まない
 * @returns 回数
 */
async function countErrors(env: Bindings, fingerprint: string, from: number, to: number): Promise<number> {
  let total = 0;
  for (const db of recordDbs(env, from, to)) {
    const row = await db.prepare("SELECT count(*) AS n FROM error_events WHERE fingerprint = ? AND at >= ? AND at < ?").bind(fingerprint, from, to).first<{ n: number }>();
    total += row?.n ?? 0;
  }
  return total;
}

/**
 * 直してから 7 日たった物の効き目を確かめる。読んだ時に fixed のままの物だけを書き、同時に確かめた 2 つの片方だけが Issue に書く
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param now 今の時刻
 */
export async function checkEffects(env: Bindings, tracker: IssueTracker, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, fingerprint, repo, issue_number, fixed_at FROM findings WHERE status = 'fixed' AND fixed_at <= ? ORDER BY id")
    .bind(now - WEEK_MS)
    .all();
  const clock: Clock = { now: () => now };
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
 * 1 件の効き目を確かめて書く
 * @param env バインディング
 * @param tracker GitHub の Issue
 * @param row 直した物
 * @param now 今の時刻
 */
async function checkOne(env: Bindings, tracker: IssueTracker, row: z.infer<typeof Fixed>, now: number): Promise<void> {
  const effect = FindingEffect.parse({
    before: await countErrors(env, row.fingerprint, row.fixed_at - WEEK_MS, row.fixed_at),
    after: await countErrors(env, row.fingerprint, row.fixed_at, row.fixed_at + WEEK_MS),
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
          body: `直した後の 7 日のエラーが ${String(effect.after)} 回で、直す前の ${String(effect.before)} 回から減らなかった。直した PR を戻す。`,
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
    .set({ status: worked ? "verified" : "reverted", effect })
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
  const text = `直す前の 7 日は ${String(effect.before)} 回、直した後の 7 日は ${String(effect.after)} 回。`;
  await tracker.comment(row.repo, row.issue_number, worked ? `${text}効いたので閉じる。` : `${text}効かなかったので、直しを戻すタスクを足した。`);
  if (worked) await tracker.close(row.repo, row.issue_number);
}

/**
 * findings の行が fixed のままかを確かめる条件を作る
 * @param id findings の ID
 * @returns SQL の条件
 */
function sqlExists(id: string) {
  return sql`EXISTS (SELECT 1 FROM ${findings} WHERE ${findings.id} = ${id} AND ${findings.status} = 'fixed')`;
}
