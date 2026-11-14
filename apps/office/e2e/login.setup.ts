// ブラウザーごとに、オーナーのログインセッションを 1 つ作り、そのブラウザーの全部のテストで使う
import { expect, test as setup } from "@playwright/test";
import { LOGIN_PROJECT, sessionState } from "./helpers/session.ts";

setup("ログインセッションを作る", async ({ page }) => {
  // 開発の入口の最初の組み立てを待つ
  setup.setTimeout(60_000);
  const browser = setup.info().project.name.slice(LOGIN_PROJECT.length);
  // ログインセッションの開始は 1 分 10 回までなので、テストごとに作らず 1 つを使い回す。クッキーはそのブラウザーの中で作り、ほかのブラウザーに渡さない
  await page.goto("/");
  const status = await page.evaluate(async () => (await fetch("/api/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" } })).status);
  expect(status).toBe(201);
  // 開発の入口は http なので、Secure の無い開発の名前で受け取れている (dev/plugin.ts の localSessionCookie)
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => [c.name, c.secure])).toContainEqual(["ko_session", false]);
  const me = await page.evaluate(async () => (await fetch("/api/v1/me")).status);
  expect(me).toBe(200);
  await page.context().storageState({ path: sessionState(browser) });
});
