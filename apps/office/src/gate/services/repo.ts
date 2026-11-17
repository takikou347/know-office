// サービスのリポジトリを、GitHub App で触れるリポジトリから選ぶ確かめ。試作に進める時と設定で変える時が同じ確かめを通す (サービスと拡張の 3.1、3.3)
import { AppError, DOCS_REPO_KEY } from "@know-office/core";
import { type SQL, sql } from "drizzle-orm";
import { loadDocsRepo } from "../devloop/docs-setting.ts";
import type { Bindings } from "../env.ts";
import { loadLink, type TokenDeps } from "../github/app.ts";
import { hasInstallationRepo, installedAs } from "../github/repos.ts";

/**
 * リポジトリを選べるかを確かめ、書く時に重ねる条件を返す。確かめた後に連携が変わるか、同じリポジトリが設計書のリポジトリに選ばれたら、条件が合わず書かない
 * @param env バインディング
 * @param deps GitHub の鍵の出し手
 * @param repo 選んだリポジトリ。形は入力のスキーマで確かめてある
 * @param pointer 422 の時に指す入力の場所
 * @returns 確かめた時のインストールのままで、設計書のリポジトリでない事の SQL の条件
 * @throws conflict GitHub とまだつないでいない時、今の設計書のリポジトリと同じ時
 * @throws validation_failed 触れるリポジトリに無い時
 * @throws upstream_failed GitHub が失敗を返した時
 */
export async function chooseRepo(env: Bindings, deps: TokenDeps, repo: string, pointer: string): Promise<SQL> {
  const link = await loadLink(env);
  if (!link.app || !link.installation) throw new AppError("conflict", "GitHub とまだつないでいないので、リポジトリを選べない");
  // 設計書のリポジトリは非公開で、ゲートウェイの判断で守る。サービスのリポジトリにすると、その守りが普通のルールに替わる
  const docs = await loadDocsRepo(env.DB);
  if (docs !== null && docs.repo.toLowerCase() === repo.toLowerCase()) throw new AppError("conflict", "設計書のリポジトリはサービスのリポジトリに選べない");
  if (!(await hasInstallationRepo(env, deps, repo))) {
    throw new AppError("validation_failed", "触れるリポジトリに無い", { errors: [{ pointer, detail: "GitHub App のインストールで選んだリポジトリから選ぶ" }] });
  }
  // 確かめた後に設計書のリポジトリへ選ばれた時も書かない
  const notDocs = sql`NOT EXISTS (SELECT 1 FROM settings WHERE key = ${DOCS_REPO_KEY} AND scope = 'office' AND version = (SELECT MAX(version) FROM settings WHERE key = ${DOCS_REPO_KEY} AND scope = 'office') AND lower(json_extract(value, '$.repo')) = ${repo.toLowerCase()})`;
  return sql`${installedAs(link.installation.version)} AND ${notDocs}`;
}
