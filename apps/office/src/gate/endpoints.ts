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
};

const TEAM = /^[a-z0-9-]+$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/**
 * 外の宛先を返す。development でない時と ENVIRONMENT が無い時は本物の宛先
 * @param env 変数
 * @returns Access の公開鍵、Claude API、GitHub の宛先
 * @throws internal ACCESS_TEAM の形が違う時、development なのに代わりの物が手元に無い時
 */
export function endpoints(env: EndpointEnv): Endpoints {
  if (!TEAM.test(env.ACCESS_TEAM)) throw new AppError("internal", "ACCESS_TEAM の形が違う");
  if (env.ENVIRONMENT !== "development") {
    return {
      accessCerts: `https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`,
      anthropic: "https://api.anthropic.com",
      github: "https://api.github.com",
    };
  }
  const base = env.DEV_FAKES_URL ?? "";
  // 開発環境でも、手元でない宛先を代わりの物として信じない
  if (!LOCAL.test(base)) throw new AppError("internal", "DEV_FAKES_URL が手元の宛先でない");
  return { accessCerts: `${base}/access/cdn-cgi/access/certs`, anthropic: `${base}/anthropic`, github: `${base}/github` };
}
