// GitHub App のインストールで選んだ、触れるリポジトリを読む。連携の画面の一覧とサービスのリポジトリの確かめが同じ読み方を使う (タスクとレビューの 3.2、サービスと拡張の 3.3)
import { AppError, GitHubInstallationRepos, type Repo } from "@know-office/core";
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
  for (let page = 1; page <= SEARCH_PAGES; page += 1) {
    const { repos, total } = await installationRepos(env, deps, page, PAGE_MAX);
    if (repos.some((r) => r.fullName.toLowerCase() === repo.toLowerCase())) return true;
    if (page * PAGE_MAX >= total) return false;
  }
  throw new AppError("upstream_failed", "触れるリポジトリが多すぎて読み切れない");
}
