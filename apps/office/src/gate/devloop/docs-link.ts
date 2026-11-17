// タスクが同じ時に直す設計書の PR の行 task_docs。設計書の PR を出す前に取り (同じサービスの設計書を直す別のタスクがあれば取れず 409)、コードの PR の docsPr で結ぶ (開発の回し方の 3.6)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "@know-office/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { services, taskDocs } from "../db/main.ts";
import { isDocsRepo, loadDocsRepo } from "./docs-setting.ts";

/** 設計書の PR の行 */
export type DocsRow = typeof taskDocs.$inferSelect;

const Changed = z.object({ meta: z.object({ changes: z.number() }) });

/**
 * 書いた行の数を読む
 * @param result D1 の run の返事
 * @returns 変えた行の数
 */
function changes(result: unknown): number {
  const parsed = Changed.safeParse(result);
  return parsed.success ? parsed.data.meta.changes : 0;
}

/**
 * タスクの設計書の PR の行を読む
 * @param db 今の状態の D1
 * @param nodeId タスク ID
 * @returns 行。無ければ null
 */
export async function docsOf(db: D1Database, nodeId: string): Promise<DocsRow | null> {
  const [row] = await drizzle(db).select().from(taskDocs).where(eq(taskDocs.nodeId, nodeId)).limit(1);
  return row ?? null;
}

/**
 * 設計書の PR の行を取る。同じサービスの設計書を直す別のタスク (設計書を書くタスクか、行を持つタスク) が done と dropped でない間 (doing、review、todo、waiting_owner、stopped) は取れない。1 文で書き、同じ時に来た 2 つのうち取れるのは 1 つ
 * @param db 今の状態の D1
 * @param claim 取る行
 * @param claim.nodeId タスク ID
 * @param claim.serviceId サービス ID
 * @param claim.repo 設計書のリポジトリ
 * @param claim.branch 設計書の PR のブランチ
 * @param claim.now 今の時刻
 * @returns 取れたら true
 */
export async function claimDocs(db: D1Database, claim: { nodeId: string; serviceId: string; repo: string; branch: string; now: number }): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO task_docs (node_id, service_id, repo, pr_number, branch, created_at)
       SELECT ?1, ?2, ?3, NULL, ?4, ?5
       WHERE NOT EXISTS (
         SELECT 1 FROM nodes o
         WHERE o.scope = ?2 AND o.id <> ?1 AND o.status NOT IN ('done', 'dropped')
           AND (o.source = 'design:' || ?2 OR EXISTS (SELECT 1 FROM task_docs d WHERE d.node_id = o.id)))
       ON CONFLICT DO NOTHING`,
    )
    .bind(claim.nodeId, claim.serviceId, claim.repo, claim.branch, claim.now)
    .run();
  return changes(result) > 0;
}

/**
 * 行に PR の番号を書く。まだ番号が無い行だけ
 * @param db 今の状態の D1
 * @param nodeId タスク ID
 * @param prNumber PR の番号
 */
export async function setDocsPr(db: D1Database, nodeId: string, prNumber: number): Promise<void> {
  await db.prepare("UPDATE task_docs SET pr_number = ? WHERE node_id = ? AND pr_number IS NULL").bind(prNumber, nodeId).run();
}

/**
 * 出す前の確かめで断った時に、取った行を消す。PR を持つ行は消さない
 * @param db 今の状態の D1
 * @param nodeId タスク ID
 */
export async function dropClaim(db: D1Database, nodeId: string): Promise<void> {
  await db.prepare("DELETE FROM task_docs WHERE node_id = ? AND pr_number IS NULL").bind(nodeId).run();
}

/**
 * main に入った PR の行を、新しいブランチの行に替える。読んだ PR の番号のままの時だけ
 * @param db 今の状態の D1
 * @param row 今の行
 * @param branch 新しいブランチ
 * @returns 替えられたら true
 */
export async function replaceDocsBranch(db: D1Database, row: DocsRow, branch: string): Promise<boolean> {
  const result = await db.prepare("UPDATE task_docs SET pr_number = NULL, branch = ? WHERE node_id = ? AND pr_number = ?").bind(branch, row.nodeId, row.prNumber).run();
  return changes(result) > 0;
}

/**
 * コードの PR に結べる設計書の PR の行かを確かめる。同じタスクで出した PR で、今の設計書のリポジトリの物でなければ断る。結ぶ PR が無く行も無ければ null
 * @param db 今の状態の D1
 * @param nodeId タスク ID
 * @param docsPr 入力の docsPr
 * @returns 結ぶ行。結ばなければ null
 * @throws validation_failed docsPr が同じタスクで出した PR でない時、行があるのに docsPr が無い時
 * @throws conflict 行のリポジトリが今の設計書のリポジトリでない時
 */
export async function linkedRow(db: D1Database, nodeId: string, docsPr: number | undefined): Promise<DocsRow | null> {
  const row = await docsOf(db, nodeId);
  if (row === null && docsPr === undefined) return null;
  if (row === null || row.prNumber === null || row.prNumber !== docsPr) throw new AppError("validation_failed", "docsPr は同じタスクで docs_pr_open で出した設計書の PR の番号にする", { errors: [{ pointer: "#/docsPr", detail: row === null ? "このタスクは設計書の PR を出していない" : "設計書の PR を出したので、docsPr にその番号を書く" }] });
  const docs = await loadDocsRepo(db);
  if (docs === null || docs.repo.toLowerCase() !== row.repo.toLowerCase()) throw new AppError("conflict", "設計書のリポジトリが変わった。今の設計書のリポジトリへ出し直す");
  return row;
}

/**
 * タスクが、設計書のリポジトリへ push できるかを見る。サービスのタスク (scope がサービス ID、repo がそのサービスのリポジトリ) だけが、今の設計書のリポジトリ (大文字小文字を区別しない) に push できる
 * @param db 今の状態の D1
 * @param task タスクの範囲とリポジトリ
 * @param task.scope タスクの範囲
 * @param task.repo タスクのリポジトリ
 * @param repo push 先のリポジトリ
 * @returns push できるなら true
 */
export async function mayPushDocs(db: D1Database, task: { scope: string; repo: string | null }, repo: string): Promise<boolean> {
  if (task.repo === null || !(await isDocsRepo(db, repo))) return false;
  const [service] = await drizzle(db).select({ id: services.id }).from(services).where(and(eq(services.id, task.scope), eq(services.repo, task.repo))).limit(1);
  return service !== undefined;
}
