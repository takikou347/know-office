// 本物の wrangler.jsonc の Worker を本物の workerd で起こし、/api/* と GitHub の通知の道だけが入口に来て、ほかの道は画面を返す事を確かめる
import { Problem } from "@know-office/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { screenCsp } from "../../src/gate/headers.ts";
import { type OfficeWorker, startOfficeWorker } from "../helpers/worker.ts";

// 入口と画面の分かれ方は要求ごとに変わらないので、workerd は 1 度だけ起こす
let worker: OfficeWorker | undefined;
beforeAll(async () => {
  worker = await startOfficeWorker();
}, 30_000);
afterAll(() => worker?.dispose());

/**
 * 起こした Worker に要求を出す
 * @param path / から始まる道
 * @param headers 付けるヘッダー
 * @param init メソッドと本文。無ければ GET
 * @returns 返事
 */
function request(path: string, headers?: Record<string, string>, init?: { method: string; body?: string }): Promise<Response> {
  if (!worker) throw new Error("Worker を起こせていない");
  return worker.request(path, headers, init);
}

// ブラウザーでアドレスを開いた時のヘッダー。画面のファイルの SPA への戻しは、この開き方の時に効く
const NAVIGATE = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };

describe("入口と画面の分かれ方 (wrangler.jsonc)", () => {
  it("Access を通らない要求", async () => {
    const res = await request("/api/v1/health");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(Problem.parse(await res.json()).code).toBe("unauthenticated");
  });

  it("ブラウザーで /api の下を開いても入口が受け、画面を返さない", async () => {
    const res = await request("/api/v1/health", NAVIGATE);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(Problem.parse(await res.json()).code).toBe("unauthenticated");
  });

  it("/api の下の知らない道も入口が受け、画面を返さない", async () => {
    const res = await request("/api/v1/nothing", NAVIGATE);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
  });

  it("GitHub の通知の道は入口が受け、署名の無い通知を 401 で断る", async () => {
    const res = await request("/hooks/v1/github", { "Content-Type": "application/json", "X-GitHub-Event": "ping" }, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(Problem.parse(await res.json()).code).toBe("unauthenticated");
  });

  it.each(["/hooks/v1/other", "/hooks"])("通知の道のほかの %s は入口を通らず画面を返す", async (path) => {
    const res = await request(path, NAVIGATE);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it.each(["/", "/dashboard", "/settings/sessions"])("ブラウザーで %s を開くと入口を通らず画面の index.html を返す", async (path) => {
    const res = await request(path, NAVIGATE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root"></div>');
  });
});

describe("画面と入力のセキュリティ", () => {
  // ほかのサイトの枠に入れられると、ブラウザーは frame-ancestors 'none' を見て画面を出さない
  it("埋め込み", async () => {
    for (const path of ["/", "/dashboard"]) {
      const res = await request(path, NAVIGATE);
      expect(res.status).toBe(200);
      const nonce = nonceOf(await res.text());
      expect(res.headers.get("Content-Security-Policy")).toBe(screenCsp(nonce));
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  // CodeMirror と vite の差し込む <style> だけを、要求ごとの nonce で許す。script と、nonce の無い style は断ったまま
  it("画面の HTML は要求ごとに新しい nonce を持ち、CSP の style-src だけがその nonce を許す", async () => {
    const seen = new Set<string>();
    for (const path of ["/", "/", "/staff"]) {
      const res = await request(path, NAVIGATE);
      const nonce = nonceOf(await res.text());
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain(`style-src 'self' 'nonce-${nonce}';`);
      expect(csp).toContain("script-src 'self';");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      seen.add(nonce);
    }
    expect(seen.size).toBe(3);
    // 画面のファイル (JS と CSS) は入口を通らず、静的な CSP のまま
    const js = await request("/assets/main.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Security-Policy")).toBe(screenCsp(null));
  });
});

/**
 * 画面の HTML の meta から nonce を読む (vite の html.cspNonce の形)
 * @param html 画面の HTML
 * @returns nonce
 */
function nonceOf(html: string): string {
  const nonce = /<meta property="csp-nonce" nonce="([^"]+)"/.exec(html)?.[1];
  if (!nonce) throw new Error("画面の HTML に csp-nonce の meta が無い");
  return nonce;
}
