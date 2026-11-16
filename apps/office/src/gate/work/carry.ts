// 退勤で次の勤務へ続けたタスクの書き方。した仕事の行と同じバッチでタスクを todo に戻し、戻せたタスクだけ出来事を残す (社員と勤怠の 3.3)
import { log } from "@know-office/core";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import { nodes, workEntries } from "../db/main.ts";

/** 次の勤務へ続けたタスク。workId はした仕事の行の ID、at は離れた時刻 */
export type CarriedTask = { workId: string; nodeId: string; at: number };

/** D1 に書くした仕事の行のうち使う所 */
type WorkRow = typeof workEntries.$inferInsert & { id: string };

/** した仕事の行を足す文と、todo に戻す文がバッチの何番目か */
export type WorkBatch = { statements: BatchItem<"sqlite">[]; carries: { index: number; row: WorkRow }[] };

/** UPDATE の文の答えのうち、変えた行の数 */
const Changed = z.object({ meta: z.object({ changes: z.number() }).loose() }).loose();

/**
 * した仕事の行を足す文を作る。結果が continued の行は、その前にタスクを todo に戻す文を置き、同じバッチで流す
 * 戻すのは行がまだ D1 に無い時だけなので、書き直しでは戻さず、起き直すまでにタスクがまた取られていても doing のまま残る。オーナーが止めたか担当を変えたタスクも変えない
 * @param orm 今の状態の D1
 * @param staffId 社員 ID
 * @param work した仕事の行
 * @param offset バッチでこの文の前に並ぶ文の数
 * @returns 文と、戻す文の位置
 */
export function workStatements(orm: DrizzleD1Database, staffId: string, work: readonly WorkRow[], offset: number): WorkBatch {
  const batch: WorkBatch = { statements: [], carries: [] };
  for (const row of work) {
    if (row.result === "continued") {
      const written = orm.select({ id: workEntries.id }).from(workEntries).where(eq(workEntries.id, row.id));
      batch.carries.push({ index: offset + batch.statements.length, row });
      batch.statements.push(
        orm
          .update(nodes)
          .set({ status: "todo", version: sql`${nodes.version} + 1`, updatedAt: row.endedAt })
          .where(and(eq(nodes.id, row.nodeId), eq(nodes.assignee, staffId), eq(nodes.status, "doing"), notExists(written))),
      );
    }
    batch.statements.push(orm.insert(workEntries).values(row).onConflictDoNothing());
  }
  return batch;
}

/**
 * バッチの答えから、todo に戻せたタスクを並べる。書き直しで戻す文が何も変えなかった時は、タスクが続けた時刻に続けた社員の todo になっているかで決める
 * オーナーが止めたか担当を変えたタスク、起き直すまでにまた取られたタスクは入れない
 * @param orm 今の状態の D1
 * @param staffId 社員 ID
 * @param batch 作った文
 * @param results バッチの答え
 * @returns 戻せたタスク
 */
export async function carriedOf(orm: DrizzleD1Database, staffId: string, batch: WorkBatch, results: readonly unknown[]): Promise<CarriedTask[]> {
  const changed = (index: number) => Changed.safeParse(results[index]).data?.meta.changes === 1;
  const unsure = batch.carries.filter((c) => !changed(c.index)).map((c) => c.row.nodeId);
  const rows = unsure.length === 0 ? [] : await orm.select({ id: nodes.id, status: nodes.status, assignee: nodes.assignee, updatedAt: nodes.updatedAt }).from(nodes).where(inArray(nodes.id, unsure));
  const kept = (row: WorkRow) => rows.some((n) => n.id === row.nodeId && n.status === "todo" && n.assignee === staffId && n.updatedAt === row.endedAt);
  return batch.carries.filter((c) => changed(c.index) || kept(c.row)).map(({ row }) => ({ workId: row.id, nodeId: row.nodeId, at: row.endedAt }));
}

/**
 * 続けたタスクの出来事を書く。記録の D1 に書けなくても社員を止めず、エラーログに残して、書けなかった物を返す。社員 DO は次の操作で書き直す
 * @param staffId 社員 ID
 * @param events 溜めた出来事
 * @param write 出来事を 1 つ書く。同じ出来事を書き直しても 1 行にする
 * @returns 書けなかった出来事
 */
export async function writeCarried(staffId: string, events: readonly CarriedTask[], write: (event: CarriedTask) => Promise<void>): Promise<CarriedTask[]> {
  const left: CarriedTask[] = [];
  for (const event of events) {
    try {
      await write(event);
    } catch (error) {
      log("warn", "staff_event_failed", { staffId, nodeId: event.nodeId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      left.push(event);
    }
  }
  return left;
}
