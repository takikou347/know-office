// テストで使う本物の D1 (wrangler の手元の D1)。マイグレーションを流した空の DB と REC_<年> を作る
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

/** テストの D1 */
export type TestD1 = {
  /** 今の状態の DB */
  DB: D1Database;
  /** 2026 年の記録 */
  REC_2026: D1Database;
  /** 2027 年の記録 */
  REC_2027: D1Database;
  /** 止める */
  dispose(): Promise<void>;
};

/**
 * マイグレーションのフォルダの SQL を文ごとに並べる
 * @param folder main か ledger
 * @returns SQL の文
 */
function statements(folder: "main" | "ledger"): string[] {
  const dir = join(MIGRATIONS, folder);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .flatMap((file) => readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint"))
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * マイグレーションのフォルダの SQL を順に流す
 * @param db 流す先
 * @param folder main か ledger
 */
export async function migrate(db: D1Database, folder: "main" | "ledger"): Promise<void> {
  for (const sql of statements(folder)) await db.prepare(sql).run();
}

/**
 * DB のテーブルを全部消し、main のマイグレーションを流し直す。D1 を作り直すより速いので、ファイルで 1 つの D1 をテストごとに空にする時に使う
 * @param db 空にする DB
 */
export async function resetMain(db: D1Database): Promise<void> {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  // 往復を減らすため、消すのと作るのをそれぞれ 1 つの batch で流す
  const drops = tables.results.map((t) => db.prepare(`DROP TABLE IF EXISTS "${t.name}"`));
  if (drops.length > 0) await db.batch(drops);
  await db.batch(statements("main").map((sql) => db.prepare(sql)));
}

/**
 * マイグレーションを流した空の D1 を作る。テストごとに 1 つ作る
 * @returns DB と REC_<年> と dispose
 */
export async function createTestD1(): Promise<TestD1> {
  const proxy = await getPlatformProxy<{ DB: D1Database; REC_2026: D1Database; REC_2027: D1Database }>({
    configPath: join(import.meta.dirname, "wrangler.jsonc"),
    persist: false,
  });
  const { DB, REC_2026, REC_2027 } = proxy.env;
  await migrate(DB, "main");
  await migrate(REC_2026, "ledger");
  await migrate(REC_2027, "ledger");
  return { DB, REC_2026, REC_2027, dispose: () => proxy.dispose() };
}
