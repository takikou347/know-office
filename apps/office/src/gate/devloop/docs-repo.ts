// 設計書のリポジトリ。office の設定 devloop.docs_repo に 1 つ持ち、触れて非公開でサービスのリポジトリでない物だけを選ばせる (開発の回し方の 3.2)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, DOCS_REPO_KEY, DocsRepoValue, newId } from "@know-office/core";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services, settings } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { loadLink, type TokenDeps } from "../github/app.ts";
import { findInstallationRepo, installedAs } from "../github/repos.ts";
import { clockAt } from "../work/attendance.ts";

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

/**
 * サービスのリポジトリに同じ名前 (大文字小文字を分けない) があるかを読む
 * @param db 今の状態の D1
 * @param repo リポジトリ
 * @returns あれば true
 */
async function ownedByService(db: D1Database, repo: string): Promise<boolean> {
  const [row] = await drizzle(db).select({ id: services.id }).from(services).where(sql`lower(${services.repo}) = ${repo.toLowerCase()}`).limit(1);
  return row !== undefined;
}

/**
 * 設計書のリポジトリに選べない理由を 422 にする
 * @param detail 理由
 * @returns 422 の AppError
 */
function refuse(detail: string): AppError {
  return new AppError("validation_failed", detail, { errors: [{ pointer: "#/repo", detail }] });
}

/**
 * 設計書のリポジトリを選ぶ。触れて非公開でサービスのリポジトリでない物だけを、読んだ版のままの時だけ 1 文で書く
 * @param env バインディング
 * @param deps GitHub の鍵の出し手
 * @param input リポジトリ、読んだ版、理由、今の時刻
 * @param input.repo 選ぶリポジトリ
 * @param input.version 読んだ版
 * @param input.reason 理由
 * @param input.now 今の時刻
 * @returns 選んだ後の値。名前は GitHub の書き方で持つ
 * @throws conflict GitHub とつないでいない時、版が違う時、確かめた後に連携かサービスのリポジトリが変わった時
 * @throws validation_failed 触れるリポジトリに無い時、公開の時、サービスのリポジトリの時
 * @throws upstream_failed GitHub が失敗を返した時
 */
export async function setDocsRepo(env: Bindings, deps: TokenDeps, input: { repo: string; version: number; reason: string; now: number }): Promise<DocsRepo> {
  const link = await loadLink(env);
  if (!link.app || !link.installation) throw new AppError("conflict", "GitHub とまだつないでいないので、リポジトリを選べない");
  const found = await findInstallationRepo(env, deps, input.repo);
  if (found === null) throw refuse("GitHub App のインストールで選んだリポジトリから選ぶ");
  if (!found.private) throw refuse("設計書のリポジトリは非公開の物から選ぶ");
  if (await ownedByService(env.DB, found.fullName)) throw refuse("サービスのリポジトリは設計書のリポジトリに選べない");
  const next = input.version + 1;
  const noService = sql`NOT EXISTS (SELECT 1 FROM ${services} WHERE lower(${services.repo}) = ${found.fullName.toLowerCase()})`;
  const written = await drizzle(env.DB)
    .insert(settings)
    .select(
      sql`SELECT ${newId(clockAt(input.now))}, ${DOCS_REPO_KEY}, 'office', ${JSON.stringify({ repo: found.fullName })}, ${next}, 'owner', ${input.reason}, ${input.now} WHERE COALESCE((SELECT MAX(${settings.version}) FROM ${settings} WHERE ${settings.key} = ${DOCS_REPO_KEY} AND ${settings.scope} = 'office'), 0) = ${input.version} AND ${installedAs(link.installation.version)} AND ${noService}`,
    )
    .returning({ id: settings.id });
  if (written.length === 0) throw new AppError("conflict", "バージョンが違うか、書く間に連携かサービスのリポジトリが変わった");
  return { repo: found.fullName, version: next };
}

/**
 * 試作に進める時に、今の設計書のリポジトリが使える事を確かめる。触れて非公開でサービスのリポジトリでない事を見て、書く時に重ねる条件を返す
 * @param env バインディング
 * @param deps GitHub の鍵の出し手
 * @returns リポジトリと、読んだ版と連携のままの時だけ書く SQL の条件
 * @throws conflict 選んでいない時、GitHub とつないでいない時、触れるリポジトリから外れたか公開になった時、サービスのリポジトリと同じ時
 * @throws upstream_failed GitHub が失敗を返した時
 */
export async function requireDocsRepo(env: Bindings, deps: TokenDeps): Promise<{ repo: string; still: SQL }> {
  const docs = await loadDocsRepo(env.DB);
  if (docs === null) throw new AppError("conflict", "設計書のリポジトリを設定で選んでいない");
  const link = await loadLink(env);
  if (!link.app || !link.installation) throw new AppError("conflict", "GitHub とまだつないでいない");
  const found = await findInstallationRepo(env, deps, docs.repo);
  if (found === null || !found.private) throw new AppError("conflict", "設計書のリポジトリが触れる非公開のリポジトリでなくなった。設定で選び直す");
  if (await ownedByService(env.DB, docs.repo)) throw new AppError("conflict", "設計書のリポジトリがサービスのリポジトリと同じ。設定で選び直す");
  const same = sql`COALESCE((SELECT MAX(${settings.version}) FROM ${settings} WHERE ${settings.key} = ${DOCS_REPO_KEY} AND ${settings.scope} = 'office'), 0) = ${docs.version}`;
  return { repo: found.fullName, still: sql`${installedAs(link.installation.version)} AND ${same}` };
}
