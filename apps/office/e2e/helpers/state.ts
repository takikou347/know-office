// 画面の通しが使う手元の D1 と DO の置き場。開発の入口 (pnpm dev) の .wrangler/state と分け、通しの片付け (パスキーを消す、通知を既読にする) が開発の状態に触らないようにする
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const office = join(import.meta.dirname, "../..");

/** 置き場を替える環境変数の名前。vite.config.ts の cloudflare() と package.json の db:local が読む */
export const PERSIST_ENV = "KO_PERSIST_DIR";

/** 通しの置き場 (apps/office から見た道)。vite の cloudflare() と wrangler の --persist-to は、どちらもこの下の v3 に置く */
export const E2E_STATE = ".wrangler/e2e-state";

/** 開発の入口の置き場。vite の cloudflare() と wrangler の --local の既定 */
export const DEV_STATE = ".wrangler/state";

/** 通しの前に控えた、開発の置き場のファイルの一覧の置き場 */
export const DEV_SNAPSHOT = join(office, ".wrangler/e2e-dev-snapshot.json");

/**
 * 開発の置き場のファイルを、道と大きさと書いた時刻で並べる。置き場が無ければ空
 * @returns 道の順に並べた「道 大きさ 時刻」の行
 */
export function devStateFiles(): string[] {
  const root = join(office, DEV_STATE);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => {
      const stat = statSync(path);
      return `${relative(root, path)} ${String(stat.size)} ${String(stat.mtimeMs)}`;
    })
    .toSorted();
}
