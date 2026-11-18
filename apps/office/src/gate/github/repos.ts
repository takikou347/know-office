// GitHub App のインストールで選んだ、触れるリポジトリを読む。連携の画面の一覧とサービスのリポジトリの確かめが同じ読み方を使う (GitHub の連携の 3.1、サービスと拡張の 3.3)
import { AppError, GitHubInstallationRepos, type Repo } from "@know-office/core";
import { type SQL, sql } from "drizzle-orm";
import type { Bindings } from "../env.ts";
import { callGitHub, githubToken, parseGitHub, type TokenDeps } from "./app.ts";

/** 1 ページの上限。GitHub の GET /installation/repositories の per_page は 100 まで */
const PAGE_MAX = 100;

/** サービスのリポジトリを探す時に読むページの上限。1,000 件を超えるインストールは選ばせない */
const SEARCH_PAGES = 10;

/**
 * インストールで選んだリポジトリを 1 ページ読む
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @param page ページの番号 (1 から)
 * @param limit 1 ページの件数 (1 から 100)
 * @returns リポジトリと全体の数
 * @throws upstream_failed つないでいない時、GitHub が失敗を返した時、返事の形が違う時
 */
export async function installationRepos(env: Bindings, deps: TokenDeps, page: number, limit: number): Promise<{ repos: Repo[]; total: number }> {
  const token = await githubToken(env, deps, null, { metadata: "read" });
  const res = await callGitHub(env, deps.fetcher, `installation/repositories?per_page=${String(limit)}&page=${String(page)}`, { headers: { authorization: `Bearer ${token.reveal()}` } });
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  const found = await parseGitHub(res, GitHubInstallationRepos);
  return { repos: found.repositories.map((r) => ({ fullName: r.full_name, private: r.private })), total: found.total_count };
}

/**
 * インストールで選んだリポジトリの中にあるかを、ページを順に読んで確かめる
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @param repo 探すリポジトリ
 * @returns あれば true
 * @throws upstream_failed GitHub が失敗を返した時、10 ページで読み切れない時
 */
export async function hasInstallationRepo(env: Bindings, deps: TokenDeps, repo: string): Promise<boolean> {
  return (await findInstallationRepo(env, deps, repo)) !== null;
}

/**
 * インストールで選んだリポジトリの中から、名前の大文字小文字を分けずに 1 つ探す
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @param repo 探すリポジトリ
 * @returns GitHub の名前と公開か非公開か。無ければ null
 * @throws upstream_failed GitHub が失敗を返した時、10 ページで読み切れない時
 */
export async function findInstallationRepo(env: Bindings, deps: TokenDeps, repo: string): Promise<Repo | null> {
  for (let page = 1; page <= SEARCH_PAGES; page += 1) {
    const { repos, total } = await installationRepos(env, deps, page, PAGE_MAX);
    const found = repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
    if (found) return found;
    if (page * PAGE_MAX >= total) return null;
  }
  throw new AppError("upstream_failed", "触れるリポジトリが多すぎて読み切れない");
}

/**
 * 確かめた時のインストールのままである事の SQL の条件を作る。確かめた後に連携が変われば、条件が合わず書かない
 * @param version 確かめた時のインストールの版
 * @returns SQL の条件
 */
export function installedAs(version: number): SQL {
  return sql`EXISTS (SELECT 1 FROM vault WHERE name = 'github_installation' AND version = ${version} AND revoked_at IS NULL)`;
}
