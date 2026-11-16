// サービスのリポジトリを、GitHub App で触れるリポジトリから選ぶ確かめ。試作に進める時と設定で変える時が同じ確かめを通す (サービスと拡張の 3.1、3.3)
import { AppError } from "@know-office/core";
import { type SQL, sql } from "drizzle-orm";
import type { Bindings } from "../env.ts";
import { loadLink, type TokenDeps } from "../github/app.ts";
import { hasInstallationRepo } from "../github/repos.ts";

/**
 * リポジトリを選べるかを確かめ、書く時に重ねる条件を返す。確かめた後に連携が変わったら、条件が合わず書かない
 * @param env バインディング
 * @param deps GitHub の鍵の出し手
 * @param repo 選んだリポジトリ。形は入力のスキーマで確かめてある
 * @param pointer 422 の時に指す入力の場所
 * @returns 確かめた時のインストールのままである事の SQL の条件
 * @throws conflict GitHub とまだつないでいない時
 * @throws validation_failed 触れるリポジトリに無い時
 * @throws upstream_failed GitHub が失敗を返した時
 */
export async function chooseRepo(env: Bindings, deps: TokenDeps, repo: string, pointer: string): Promise<SQL> {
  const link = await loadLink(env);
  if (!link.app || !link.installation) throw new AppError("conflict", "GitHub とまだつないでいないので、リポジトリを選べない");
  if (!(await hasInstallationRepo(env, deps, repo))) {
    throw new AppError("validation_failed", "触れるリポジトリに無い", { errors: [{ pointer, detail: "GitHub App のインストールで選んだリポジトリから選ぶ" }] });
  }
  return sql`EXISTS (SELECT 1 FROM vault WHERE name = 'github_installation' AND version = ${link.installation.version} AND revoked_at IS NULL)`;
}
