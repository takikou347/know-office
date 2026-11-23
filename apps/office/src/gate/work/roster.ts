// 社員の名簿。在籍の社員を並べ、職種から担当を選ぶ (データの 2 章、タスクとレビューの 3.3)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type StaffId, StaffJob } from "@know-office/core";
import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { nodes, staff } from "../db/main.ts";

/** staff の行 */
export type StaffRow = typeof staff.$inferSelect;

/** 終わったタスクの状態。担当の手の空き具合に数えない */
const FINISHED = ["done", "dropped"] as const;

/** 名簿の並び。社長を先に、ほかは作った順、同じ時刻は ID の順 */
const ORDER = [desc(sql`${staff.job} = 'president'`), asc(staff.createdAt), asc(staff.id)] as const;

/**
 * 在籍の社員を並べる
 * @param db 今の状態の D1
 * @returns 社長、作った順、ID の順の社員の行
 */
export function activeStaff(db: D1Database): Promise<StaffRow[]> {
  return drizzle(db).select().from(staff).where(isNull(staff.retiredAt)).orderBy(...ORDER);
}

/**
 * 削除した社員も含めて、全部の社員を並べる。全体の停止のように、退職の途中で残った社員 DO も止める所で使う
 * @param db 今の状態の D1
 * @returns 社員の行
 */
export function allStaff(db: D1Database): Promise<StaffRow[]> {
  return drizzle(db).select().from(staff).orderBy(...ORDER);
}

/**
 * 在籍の社員を 1 人読む
 * @param db 今の状態の D1
 * @param staffId 社員 ID
 * @returns 行。居ないか削除した社員は undefined
 */
export async function activeStaffRow(db: D1Database, staffId: StaffId): Promise<StaffRow | undefined> {
  const [row] = await drizzle(db)
    .select()
    .from(staff)
    .where(and(eq(staff.id, staffId), isNull(staff.retiredAt)));
  return row;
}

/**
 * 在籍の社員の職種を返す
 * @param db 今の状態の D1
 * @param staffId 社員 ID
 * @returns 職種。居ないか削除した社員は null
 */
export async function jobOf(db: D1Database, staffId: StaffId): Promise<StaffJob | null> {
  const row = await activeStaffRow(db, staffId);
  return row ? StaffJob.parse(row.job) : null;
}

/** 担当を選ぶ条件 */
export type PickOptions = {
  /** このモデルでない社員を先に選ぶ。レビューを書いた社員と別のモデルにするため */
  avoidModel?: string | null | undefined;
};

/**
 * 在籍のその職種の社員から、終わりでないタスクの少ない人を選ぶ。同じ数なら作った順、ID の順。
 * タスクを書く時は、担当が在籍の社員かを D1 のトリガーが確かめるので、選んだ後に削除された社員には書けない
 * @param db 今の状態の D1
 * @param job 職種
 * @param options 選ぶ条件
 * @returns 社員 ID
 * @throws internal その職種の社員が居ない時
 */
export async function pickStaff(db: D1Database, job: StaffJob, options: PickOptions = {}): Promise<StaffId> {
  const open = drizzle(db)
    .select({ assignee: nodes.assignee, n: sql<number>`count(*)`.as("n") })
    .from(nodes)
    .where(and(eq(nodes.kind, "task"), notInArray(nodes.status, [...FINISHED])))
    .groupBy(nodes.assignee)
    .as("open");
  // 避けるモデルが無い時は空の名前と比べ、どの社員も同じ並びにする
  const avoid = options.avoidModel ?? "";
  const [row] = await drizzle(db)
    .select({ id: staff.id })
    .from(staff)
    .leftJoin(open, eq(open.assignee, staff.id))
    .where(and(eq(staff.job, job), isNull(staff.retiredAt)))
    .orderBy(sql`${staff.model} = ${avoid}`, sql`coalesce(${open.n}, 0)`, asc(staff.createdAt), asc(staff.id))
    .limit(1);
  if (!row) throw new AppError("internal", `在籍の${job}が居ない`);
  return row.id;
}
