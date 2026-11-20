// 画面の HTML を画面のファイルから読み、要求ごとの CSP の nonce を入れて返す。CodeMirror と vite が差し込む <style> を、nonce の付いた物だけ許すため (詳細設計の目次の 3.4)
import { type EndpointEnv, endpoints } from "./endpoints.ts";
import type { Bindings } from "./env.ts";
import { screenCsp } from "./headers.ts";

/** vite の html.cspNonce に渡す置き場の文字。build した index.html の meta と script、style の nonce に入り、入口が要求ごとの値に替える */
export const CSP_NONCE_PLACEHOLDER = "KO_CSP_NONCE";

/** 画面の HTML を返すのに使うバインディング */
export type ScreenEnv = Pick<Bindings, "ASSETS"> & EndpointEnv;

/**
 * ダッシュボード (/) の HTML の頭に置く、ダッシュボードの API の先読み。画面の JS を運ぶのと同じ時に読み始め、スマートフォンの 4G で 2 秒以内に出す (画面の全体の 3.4)。
 * 画面の fetch と同じ形 (cors、同じ源のクッキー) で読むので、画面が同じ道を呼んだ時にこの返事を使う
 */
const DASHBOARD_PRELOAD = '<link rel="preload" href="/api/v1/dashboard" as="fetch" crossorigin>';

/**
 * 要求ごとの nonce を作る。CSP の nonce は 128 ビット以上の乱数 (CSP Level 3 の 7.1)
 * @returns base64 の 24 文字
 */
function newNonce(): string {
  return btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * 開発の入口の CSP に直す。開発の入口 (vite) は React の差し替えの準備を文書の中の <script> で書き、html.cspNonce の nonce を付けるので、その script を nonce で許す。
 * GitHub App を作る form は代わりの GitHub に送るので、form-action を github.com から代わりの物の置き場に替える
 * @param csp 本番の CSP
 * @param nonce 要求の nonce
 * @param env バインディング
 * @returns 開発の CSP
 */
function devCsp(csp: string, nonce: string, env: ScreenEnv): string {
  const github = new URL(endpoints(env).githubWeb).origin;
  return csp.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`).replace("form-action 'self' https://github.com", `form-action 'self' ${github}`);
}

/**
 * 画面のファイルを読み、HTML なら nonce を入れて CSP を付け直す。HTML でない物はそのまま返す
 * @param request 要求
 * @param env バインディング
 * @returns 返事
 */
export async function screenResponse(request: Request, env: ScreenEnv): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  if (!(res.headers.get("Content-Type") ?? "").startsWith("text/html")) return res;
  const nonce = newNonce();
  const page = (await res.text()).replaceAll(CSP_NONCE_PLACEHOLDER, nonce);
  const html = new URL(request.url).pathname === "/" ? page.replace("<head>", `<head>\n    ${DASHBOARD_PRELOAD}`) : page;
  const headers = new Headers(res.headers);
  const csp = screenCsp(nonce);
  headers.set("Content-Security-Policy", env.ENVIRONMENT === "development" ? devCsp(csp, nonce, env) : csp);
  // nonce が要求ごとに替わるので、HTML は取っておかせない
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  headers.delete("Content-Length");
  return new Response(html, { status: res.status, headers });
}
