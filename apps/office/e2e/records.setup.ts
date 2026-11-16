// 画面の通しの前に、手元の D1 にマイグレーションと勤怠の記録を 1 度だけ流す
import { join } from "node:path";
import { test as setup } from "@playwright/test";
import { runLocalD1 } from "./flows/helpers/seed.ts";

const office = join(import.meta.dirname, "..");

setup("手元の D1 に記録を置く", () => {
  // 7 つの D1 へのマイグレーションを待つ
  setup.setTimeout(120_000);
  // 開発の入口 (vite の cloudflare) と wrangler は同じ .wrangler/state の D1 を使う
  // マイグレーションは流したものを飛ばし、種は INSERT OR IGNORE なので、塞がって流し直しても同じになる
  runLocalD1(["run", "db:local"]);
  runLocalD1(["exec", "wrangler", "d1", "execute", "DB", "--local", `--file=${join(office, "e2e/seed.sql")}`]);
});
