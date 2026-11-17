// 設計書のリポジトリの設定を読む。GitHub のルールも読む repoScope と、設計書のリポジトリを選ぶ側の両方が使うので、GitHub を呼ぶ物から分けた葉 (開発の回し方の 3.2)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, DOCS_REPO_KEY, DocsRepoValue } from "@know-office/core";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { settings } from "../db/main.ts";

/** 設計書のリポジトリの今の値と版 */
export type DocsRepo = { repo: string; version: number };

/**
 * 設計書のリポジトリの最新の値を読む
 * @param db 今の状態の D1
 * @returns 値と版。まだ選んでいなければ null
 * @throws internal 置いた値の形が違う時
 */
export async function loadDocsRepo(db: D1Database): Promise<DocsRepo | null> {
  const [row] = await drizzle(db)
    .select({ value: settings.value, version: settings.version })
    .from(settings)
    .where(and(eq(settings.key, DOCS_REPO_KEY), eq(settings.scope, "office")))
    .orderBy(desc(settings.version))
    .limit(1);
  if (!row) return null;
  // 形の違う値で判断すると設計書の守りが外れるので、読めない時は失敗にする
  const value = DocsRepoValue.safeParse(row.value);
  if (!value.success) throw new AppError("internal", "settings の devloop.docs_repo の形が違う");
  return { repo: value.data.repo, version: row.version };
}

/**
 * リポジトリが今の設計書のリポジトリかを、名前の大文字小文字を分けずに見る
 * @param db 今の状態の D1
 * @param repo リポジトリ
 * @returns 設計書のリポジトリなら true
 */
export async function isDocsRepo(db: D1Database, repo: string): Promise<boolean> {
  const docs = await loadDocsRepo(db);
  return docs !== null && docs.repo.toLowerCase() === repo.toLowerCase();
}
