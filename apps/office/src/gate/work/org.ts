// 組織図を読む。在籍の社員を社長、作った順、ID の順に並べ、今の版の役目の説明文を添える (タスクとレビューの 3.1)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type OrgStaff, StaffId, StaffJob } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { staffPrompts } from "../db/main.ts";
import { activeStaff, allStaff, type StaffRow } from "./roster.ts";

/** 組織図を読む条件 */
export type OrgQuery = { cursor?: string | undefined; limit: number };

/**
 * 並びの鍵。社長が先、次に作った時刻、同じ時刻は ID
 * @param row 社員の行
 * @returns 比べる鍵
 */
const keyOf = (row: StaffRow): [number, number, string] => [row.job === "president" ? 0 : 1, row.createdAt, row.id];

/**
 * 並びで a が b より後かを返す
 * @param a 社員の行
 * @param b 社員の行
 * @returns 後なら true
 */
function after(a: StaffRow, b: StaffRow): boolean {
  const [x, y] = [keyOf(a), keyOf(b)];
  if (x[0] !== y[0]) return x[0] > y[0];
  if (x[1] !== y[1]) return x[1] > y[1];
  return x[2] > y[2];
}

/**
 * 組織図を読む。cursor の社員より並びで後の在籍の社員から limit 件。cursor の社員が削除されていても並びの鍵で続きを出す
 * @param db 今の状態の D1
 * @param query 条件
 * @returns 社員の 1 ページと次のカーソル
 * @throws malformed_request カーソルが社員 ID でないか、居ない社員の時
 */
export async function loadOrg(db: D1Database, query: OrgQuery): Promise<{ items: OrgStaff[]; next: string | null }> {
  const people = await activeStaff(db);
  const from = query.cursor === undefined ? undefined : await cursorRow(db, query.cursor);
  const ordered = from === undefined ? people : people.filter((p) => after(p, from));
  const prompts = await drizzle(db).select().from(staffPrompts);
  const page = ordered.slice(0, query.limit);
  const items = page.map((p) => ({
    id: p.id,
    job: StaffJob.parse(p.job),
    role: p.role,
    bossId: p.bossId,
    model: p.model,
    prompt: prompts.find((v) => v.staffId === p.id && v.version === p.promptVersion)?.body ?? "",
    promptVersion: p.promptVersion,
  }));
  return { items, next: ordered.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

/**
 * カーソルを社員の行として読む。削除した社員も並びの鍵に使う
 * @param db 今の状態の D1
 * @param cursor 前の返事の meta.next
 * @returns 社員の行
 * @throws malformed_request 社員 ID でないか、居ない社員の時
 */
async function cursorRow(db: D1Database, cursor: string): Promise<StaffRow> {
  const id = StaffId.safeParse(cursor);
  // 読めないカーソルを先頭や末尾に読み替えず、要求の誤りとして断る
  if (!id.success) throw new AppError("malformed_request", "カーソルが社員 ID でない");
  const row = (await allStaff(db)).find((r) => r.id === id.data);
  if (!row) throw new AppError("malformed_request", "カーソルの社員が居ない");
  return row;
}
