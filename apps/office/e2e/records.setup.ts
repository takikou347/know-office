// 画面の通しの前に、手元の D1 にマイグレーションと勤怠の記録を流し、オーナーのログインセッションを 1 つ作って全部のテストで使う
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { SESSION_STATE } from "./helpers/session.ts";

const office = join(import.meta.dirname, "..");

setup("手元の D1 に記録を置き、ログインする", async ({ page }) => {
  // 7 つの D1 へのマイグレーションと、開発の入口の最初の組み立てを待つ
  setup.setTimeout(120_000);
  // 開発の入口 (vite の cloudflare) と wrangler は同じ .wrangler/state の D1 を使う
  execFileSync("pnpm", ["run", "db:local"], { cwd: office, stdio: "pipe" });
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", `--file=${join(office, "e2e/seed.sql")}`], { cwd: office, stdio: "pipe" });
  // ログインセッションの開始は 1 分 10 回までなので、テストごとに作らず 1 つを使い回す。クッキーは Secure なので、localhost を安全とみなすブラウザーの中で作る
  await page.goto("/");
  const status = await page.evaluate(async () => (await fetch("/api/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" } })).status);
  expect(status).toBe(201);
  await page.context().storageState({ path: SESSION_STATE });
});
