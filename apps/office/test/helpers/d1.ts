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
 * マイグレーションのフォルダの SQL を順に流す
 * @param db 流す先
 * @param folder main か records
 */
export async function migrate(db: D1Database, folder: "main" | "records"): Promise<void> {
  const dir = join(MIGRATIONS, folder);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).toSorted()) {
    for (const statement of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      const sql = statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      if (sql) await db.prepare(sql).run();
    }
  }
}

/**
 * マイグレーションを流した空の D1 を作る。テストのファイルごとに 1 つ作る
 * @returns DB と REC_<年> と dispose
 */
export async function createTestD1(): Promise<TestD1> {
  const proxy = await getPlatformProxy<{ DB: D1Database; REC_2026: D1Database; REC_2027: D1Database }>({
    configPath: join(import.meta.dirname, "wrangler.jsonc"),
    persist: false,
  });
  const { DB, REC_2026, REC_2027 } = proxy.env;
  await migrate(DB, "main");
  await migrate(REC_2026, "records");
  await migrate(REC_2027, "records");
  return { DB, REC_2026, REC_2027, dispose: () => proxy.dispose() };
}
