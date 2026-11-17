// 画面の通しの前に、手元の D1 にマイグレーションと勤怠の記録を 1 度だけ流す
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test as setup } from "@playwright/test";
import { runLocalD1 } from "./flows/helpers/seed.ts";
import { DEV_SNAPSHOT, devStateFiles } from "./helpers/state.ts";

const office = join(import.meta.dirname, "..");

setup("手元の D1 に記録を置く", () => {
  // 7 つの D1 へのマイグレーションを待つ
  setup.setTimeout(120_000);
  // 通しの後に開発の置き場が変わっていない事を確かめるため、先に控える (dev-state.teardown.ts)
  mkdirSync(dirname(DEV_SNAPSHOT), { recursive: true });
  writeFileSync(DEV_SNAPSHOT, JSON.stringify(devStateFiles()));
  // 通しの入口 (vite の cloudflare) と wrangler は、同じ通しの置き場の D1 を使う
  // マイグレーションは流したものを飛ばし、種は INSERT OR IGNORE なので、塞がって流し直しても同じになる
  runLocalD1(["run", "db:local"]);
  runLocalD1(["exec", "wrangler", "d1", "execute", "DB", "--local", `--file=${join(office, "e2e/seed.sql")}`]);
});
