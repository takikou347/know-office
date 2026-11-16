// 退勤で次の勤務へ続けたタスクの書き方。した仕事の行と同じバッチでタスクを todo に戻す (社員と勤怠の 3.3)
import { and, eq, notExists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nodes, workEntries } from "../db/main.ts";

/** 次の勤務へ続けたタスク。workId はした仕事の行の ID、at は離れた時刻 */
export type CarriedTask = { workId: string; nodeId: string; at: number };

/** D1 に書くした仕事の行のうち使う所 */
type WorkRow = typeof workEntries.$inferInsert & { id: string };

/**
 * した仕事の行を足す文を作る。結果が continued の行は、その前にタスクを todo に戻す文を置き、同じバッチで流す
 * 戻すのは行がまだ D1 に無い時だけなので、書き直しでは戻さず、起き直すまでにタスクがまた取られていても doing のまま残る。オーナーが止めたか担当を変えたタスクも変えない
 * @param orm 今の状態の D1
 * @param staffId 社員 ID
 * @param work した仕事の行
 * @returns バッチの文
 */
export function workStatements(orm: DrizzleD1Database, staffId: string, work: readonly WorkRow[]): BatchItem<"sqlite">[] {
  return work.flatMap((row) => {
    const insert = orm.insert(workEntries).values(row).onConflictDoNothing();
    if (row.result !== "continued") return [insert];
    const written = orm.select({ id: workEntries.id }).from(workEntries).where(eq(workEntries.id, row.id));
    const carry = orm
      .update(nodes)
      .set({ status: "todo", version: sql`${nodes.version} + 1`, updatedAt: row.endedAt })
      .where(and(eq(nodes.id, row.nodeId), eq(nodes.assignee, staffId), eq(nodes.status, "doing"), notExists(written)));
    return [carry, insert];
  });
}

/**
 * した仕事の行のうち、次の勤務へ続けたタスクを並べる
 * @param work した仕事の行
 * @returns 続けたタスク
 */
export function carriedOf(work: readonly WorkRow[]): CarriedTask[] {
  return work.filter((row) => row.result === "continued").map((row) => ({ workId: row.id, nodeId: row.nodeId, at: row.endedAt }));
}
