// 外の宛先を決める。開発環境の時だけ手元の代わりの物を使う。ログインと記録の 3.9
import { AppError } from "@know-office/core";

/** 宛先を決めるのに使う変数 */
export type EndpointEnv = {
  /** production、preview、development */
  ENVIRONMENT?: string;
  /** Cloudflare Access のチーム名 */
  ACCESS_TEAM: string;
  /** 開発環境の代わりの物の置き場 */
  DEV_FAKES_URL?: string;
};

/** 外の宛先 */
export type Endpoints = {
  /** Access の公開鍵 */
  accessCerts: string;
  /** Claude API */
  anthropic: string;
  /** GitHub の REST API */
  github: string;
  /** GitHub の画面。App の作成とインストール */
  githubWeb: string;
  /** GitHub の git の受け口 */
  githubGit: string;
  /** GitHub の tarball の 302 の先。この下の道だけを鍵を付けずに追う (タスクとレビューの 3.2) */
  codeload: string;
};

const TEAM = /^[a-z0-9-]+$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/**
 * 外の宛先を返す。development でない時と ENVIRONMENT が無い時は本物の宛先
 * @param env 変数
 * @returns Access の公開鍵、Claude API、GitHub の REST API と画面と git の宛先
 * @throws internal ACCESS_TEAM の形が違う時、development なのに代わりの物が手元に無い時
 */
export function endpoints(env: EndpointEnv): Endpoints {
  if (!TEAM.test(env.ACCESS_TEAM)) throw new AppError("internal", "ACCESS_TEAM の形が違う");
  if (env.ENVIRONMENT !== "development") {
    return {
      accessCerts: `https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`,
      anthropic: "https://api.anthropic.com",
      github: "https://api.github.com",
      githubWeb: "https://github.com",
      githubGit: "https://github.com",
      codeload: "https://codeload.github.com",
    };
  }
  const base = env.DEV_FAKES_URL ?? "";
  // 開発環境でも、手元でない宛先を代わりの物として信じない
  if (!LOCAL.test(base)) throw new AppError("internal", "DEV_FAKES_URL が手元の宛先でない");
  return {
    accessCerts: `${base}/access/cdn-cgi/access/certs`,
    anthropic: `${base}/anthropic`,
    github: `${base}/github`,
    githubWeb: `${base}/github/web`,
    githubGit: `${base}/github/git`,
    codeload: `${base}/codeload`,
  };
}

/**
 * 開発の代わりのワークスペースの宛先を返す。development で、代わりの物が手元にある時だけ返す。本番とプレビューのコンテナの代わりには使わない
 * @param env 変数
 * @returns 代わりのワークスペースの置き場
 * @throws internal development でない時、ENVIRONMENT が無い時、DEV_FAKES_URL が手元の宛先でない時
 */
export function devWorkspaceBase(env: EndpointEnv): string {
  if (env.ENVIRONMENT !== "development") throw new AppError("internal", "ワークスペースのコンテナが無い");
  const base = env.DEV_FAKES_URL ?? "";
  if (!LOCAL.test(base)) throw new AppError("internal", "DEV_FAKES_URL が手元の宛先でない");
  return `${base}/workspace`;
}
