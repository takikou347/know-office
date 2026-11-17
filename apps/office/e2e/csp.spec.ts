// 本番の画面のファイルに付く CSP (public/_headers) の下で、どの画面も断られる script と style を使わない事を見る (セキュリティの「弱点のチェック」)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { screens } from "../src/screen/routes.ts";
import { expect, test } from "./helpers/test.ts";

/** 本番の画面のファイルに付く CSP。開発の入口は付けないので、_headers から読んで文書の返事に足す */
const PRODUCTION_CSP = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(join(import.meta.dirname, "../public/_headers"), "utf8"))?.[1]?.trim() ?? "";

// 開発の入口は React の差し替えの準備を <script> で文書に書くので、文書の中の script だけは開く。eval と、部品が差し込む style は断ったまま見る
const CSP = PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");

// 開発の入口は CSS を vite の client が <style> で差し込む。本番の build では <link> になるので、vite の client の断りだけは数えない
const DEV_ONLY = /\/@vite\/client/;

/**
 * 文書の返事に本番の CSP を足し、断られた物を集める
 * @param page 開くページ
 * @returns 断られた物の並び (向き、元のファイル)
 */
async function watchCsp(page: Page): Promise<string[]> {
  expect(CSP).toContain("style-src 'self';");
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const res = await route.fetch();
    return route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const seen: string[] = [];
  await page.exposeFunction("reportCsp", (line: string) => seen.push(line));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      void (window as unknown as { reportCsp: (line: string) => Promise<void> }).reportCsp(`${e.effectiveDirective} ${e.sourceFile || e.blockedURI}`);
    });
  });
  return seen;
}

test.describe("本番の CSP で断られない", () => {
  for (const s of screens) {
    test(`${s.label} (${s.path})`, async ({ page }) => {
      const seen = await watchCsp(page);
      await page.goto(s.path);
      await expect(page.getByRole("heading", { level: 1, name: s.label })).toBeVisible();
      expect(seen.filter((line) => !DEV_ONLY.test(line))).toEqual([]);
    });
  }
});
