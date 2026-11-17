// 画面の HTML の返事が、要求ごとの nonce と環境に合う CSP を持つ事を確かめる (詳細設計の目次の 3.4)
import { describe, expect, it } from "vitest";
import { CSP_NONCE_PLACEHOLDER, type ScreenEnv, screenResponse } from "../../src/gate/screen-html.ts";

/**
 * 画面のファイルの代わりに、nonce の置き場を持つ HTML を返す env を作る
 * @param vars 足す変数
 * @returns バインディング
 */
function envOf(vars: Pick<ScreenEnv, "ENVIRONMENT" | "DEV_FAKES_URL">): ScreenEnv {
  const html = `<html><head><meta property="csp-nonce" nonce="${CSP_NONCE_PLACEHOLDER}"></head></html>`;
  const assets = { fetch: () => Promise.resolve(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })) };
  return { ACCESS_TEAM: "dev", ASSETS: assets, ...vars };
}

describe("画面の HTML の CSP", () => {
  it("開発では、代わりの GitHub に App を作る form を送れる", async () => {
    const res = await screenResponse(new Request("http://localhost:5280/settings"), envOf({ ENVIRONMENT: "development", DEV_FAKES_URL: "http://localhost:5281" }));
    expect(res.headers.get("Content-Security-Policy")).toMatch(/form-action 'self' http:\/\/localhost:5281(;|$)/);
  });

  it("本番では、form を送れるのは自分と github.com だけ", async () => {
    const res = await screenResponse(new Request("https://office.example/settings"), envOf({ ENVIRONMENT: "production" }));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self' https://github.com");
    expect(csp).toContain("script-src 'self';");
  });
});
