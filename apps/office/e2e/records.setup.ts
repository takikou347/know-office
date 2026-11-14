// 画面の通しの前に、手元の D1 にマイグレーションと勤怠の記録を 1 度だけ流す
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test as setup } from "@playwright/test";

const office = join(import.meta.dirname, "..");

setup("手元の D1 に記録を置く", () => {
  // 7 つの D1 へのマイグレーションを待つ
  setup.setTimeout(120_000);
  // 開発の入口 (vite の cloudflare) と wrangler は同じ .wrangler/state の D1 を使う
  execFileSync("pnpm", ["run", "db:local"], { cwd: office, stdio: "pipe" });
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", `--file=${join(office, "e2e/seed.sql")}`], { cwd: office, stdio: "pipe" });
});
