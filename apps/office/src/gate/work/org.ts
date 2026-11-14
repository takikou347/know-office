// 組織図を読む。社員を上から下へ並べ、今の版の役目の説明文を添える (タスクとレビューの 3.1)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type OrgStaff, StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { staff, staffPrompts } from "../db/main.ts";

/** 組織図を読む条件 */
export type OrgQuery = { cursor?: string | undefined; limit: number };

/**
 * 組織図を読む。社員 ID は役ごとに決まっているので、その順に cursor の後から limit 件
 * @param db 今の状態の D1
 * @param query 条件
 * @returns 社員の 1 ページと次のカーソル
 * @throws malformed_request カーソルが社員 ID でない時
 */
export async function loadOrg(db: D1Database, query: OrgQuery): Promise<{ items: OrgStaff[]; next: string | null }> {
  const after = query.cursor === undefined ? -1 : StaffId.options.indexOf(parseCursor(query.cursor));
  const orm = drizzle(db);
  const people = await orm.select().from(staff);
  const prompts = await orm.select().from(staffPrompts);
  const ordered = people
    .flatMap((p) => {
      const id = StaffId.safeParse(p.id);
      return id.success ? [{ ...p, id: id.data }] : [];
    })
    .toSorted((a, b) => StaffId.options.indexOf(a.id) - StaffId.options.indexOf(b.id))
    .filter((p) => StaffId.options.indexOf(p.id) > after);
  const page = ordered.slice(0, query.limit);
  const items = page.map((p) => ({
    id: p.id,
    role: p.role,
    bossId: p.bossId,
    model: p.model,
    prompt: prompts.find((v) => v.staffId === p.id && v.version === p.promptVersion)?.body ?? "",
    promptVersion: p.promptVersion,
  }));
  return { items, next: ordered.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

/**
 * カーソルを社員 ID として読む
 * @param cursor 前の返事の meta.next
 * @returns 社員 ID
 * @throws malformed_request 社員 ID でない時
 */
function parseCursor(cursor: string): StaffId {
  const id = StaffId.safeParse(cursor);
  // 読めないカーソルを先頭や末尾に読み替えず、要求の誤りとして断る
  if (!id.success) throw new AppError("malformed_request", "カーソルが社員 ID でない");
  return id.data;
}
