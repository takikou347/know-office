// 重なっていた作業が出た時に、待っていた子 Issue のタスクの担当を起こす (開発の回し方の 3.5)
import { StaffId } from "@know-office/core";
import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { nodes } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "./attendance.ts";

/**
 * リポジトリで doing か review の子が出た (入った、見送り、止まった) 後に、そのリポジトリで待つ子 Issue のタスクの担当へ、次を取る事を知らせる。
 * 勤務時間外の社員は呼び出さず、手の空いた勤務中の社員だけが取る。届かなくても出た側の処理は止めずエラーログに残す
 * @param env バインディング
 * @param repo リポジトリ
 * @param now 今の時刻
 */
export async function wakeWaiting(env: Bindings, repo: string, now: number): Promise<void> {
  const waiting = await drizzle(env.DB)
    .selectDistinct({ assignee: nodes.assignee })
    .from(nodes)
    .where(and(eq(nodes.kind, "task"), eq(nodes.status, "todo"), eq(nodes.repo, repo), isNotNull(nodes.issueNumber)));
  for (const { assignee } of waiting) {
    const id = StaffId.safeParse(assignee);
    if (id.success) await env.STAFF.get(env.STAFF.idFromName(id.data)).pull(now).catch((error: unknown) => recordError(env, { source: "gate", level: "error", code: "staff_wake_failed", error }, clockAt(now)));
  }
}
