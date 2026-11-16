// テストで使う本物の D1 と R2 (wrangler の miniflare の手元の物)。マイグレーションを流した空の DB と REC_<年>、会話の記録の FILES を渡す。workerd はファイルで 1 つ起こし、テストごとに中身を戻す
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { startWire } from "./d1-wire.ts";
import { atFileEnd } from "./file-end.ts";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

/** テストの D1 */
export type TestD1 = {
  /** 今の状態の DB */
  DB: D1Database;
  /** 2026 年の記録 */
  REC_2026: D1Database;
  /** 2027 年の記録 */
  REC_2027: D1Database;
  /** 会話の記録を置く R2 */
  FILES: R2Bucket;
  /** 何もしない。workerd はファイルの終わりに止める */
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

/** マイグレーションを流した直後の形。テストの後はこの形に戻す */
type Snapshot = {
  /** sqlite_master の中身。テストが形を変えていないかを見る */
  schema: string;
  /** テーブルの名前 */
  tables: string[];
  /** トリガーの名前と作る文。追記専用の表のトリガーは消すのを止めるので、戻す間だけ外す */
  triggers: { name: string; sql: string }[];
  /** マイグレーションが入れた行 */
  rows: { table: string; row: Record<string, unknown> }[];
};

/** D1 ごとの、マイグレーションを流した直後の形 */
const snapshots = new WeakMap<D1Database, Snapshot>();

const SCHEMA = "SELECT group_concat(type || ':' || name || ':' || coalesce(sql, ''), '|') AS schema FROM (SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name)";

/**
 * 今の形を読む
 * @param db 読む D1
 * @returns sqlite_master の中身を 1 つの文字列にした物
 */
async function schemaOf(db: D1Database): Promise<string> {
  return (await db.prepare(SCHEMA).first<{ schema: string | null }>())?.schema ?? "";
}

/**
 * マイグレーションを流した直後の形を覚える
 * @param db 流した直後の D1
 */
async function remember(db: D1Database): Promise<void> {
  const master = await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ type: string; name: string; sql: string }>();
  const tables = master.results.filter((m) => m.type === "table").map((m) => m.name);
  const triggers = master.results.filter((m) => m.type === "trigger").map(({ name, sql }) => ({ name, sql }));
  const rows = (await Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM "${table}"`).all()).results.map((row) => ({ table, row }))))).flat();
  snapshots.set(db, { schema: await schemaOf(db), tables, triggers, rows });
}

/**
 * DB のテーブルを、main のマイグレーションを流した直後の中身に戻す
 * @param db 戻す DB
 */
export async function resetMain(db: D1Database): Promise<void> {
  await reset(db, "main");
}

/**
 * REC_<年> のテーブルを、ledger のマイグレーションを流した直後の中身に戻す。記録を読むテストが、前のテストの記録を数えないようにする
 * @param db 戻す REC_<年>
 */
export async function resetLedger(db: D1Database): Promise<void> {
  await reset(db, "ledger");
}

/**
 * マイグレーションを流した直後の中身に戻す。形が同じなら、トリガーを外して行を消し、マイグレーションが入れた行とトリガーを戻す。形が変わっていたら、テーブルを全部消してマイグレーションを流し直す
 * @param db 戻す D1
 * @param folder main か ledger
 */
async function reset(db: D1Database, folder: "main" | "ledger"): Promise<void> {
  const snapshot = snapshots.get(db);
  if (snapshot && snapshot.schema === (await schemaOf(db))) {
    // 値を持たない文は、1 行 1 文にして exec の 1 回で流す
    await db.exec([...snapshot.triggers.map((t) => `DROP TRIGGER "${t.name}";`), ...snapshot.tables.map((t) => `DELETE FROM "${t}";`)].join("\n"));
    if (snapshot.rows.length > 0)
      await db.batch(
        snapshot.rows.map(({ table, row }) => {
          const columns = Object.keys(row);
          return db.prepare(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...Object.values(row));
        }),
      );
    if (snapshot.triggers.length > 0) await db.exec(snapshot.triggers.map((t) => `${t.sql.replaceAll(/\s+/g, " ")};`).join("\n"));
    return;
  }
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  // 往復を減らすため、消すのと作るのをそれぞれ 1 つの batch で流す
  const drops = tables.results.map((t) => db.prepare(`DROP TABLE IF EXISTS "${t.name}"`));
  if (drops.length > 0) await db.batch(drops);
  await db.batch(statements(folder).map((sql) => db.prepare(sql)));
  await remember(db);
}

/**
 * R2 の中身を全部消す
 * @param bucket 消す R2
 */
async function clear(bucket: R2Bucket): Promise<void> {
  for (;;) {
    const listed = await bucket.list({ limit: 1000 });
    if (listed.objects.length === 0) return;
    await bucket.delete(listed.objects.map((o) => o.key));
  }
}

type Bindings = { DB: D1Database; REC_2026: D1Database; REC_2027: D1Database; FILES: R2Bucket };

/** ファイルで 1 つの、マイグレーションを流した D1 と R2。workerd の起動とマイグレーションに 1 秒ほどかかるので、テストごとには起こさない */
let shared: Promise<{ env: Bindings; dispose: () => Promise<void> }> | null = null;
/** shared をもうテストに渡したか。渡した後は、次に渡す前に中身を戻す */
let handedOut = false;

/**
 * ファイルで 1 つの workerd を止める
 */
async function stop(): Promise<void> {
  const proxy = shared;
  shared = null;
  handedOut = false;
  if (proxy) await (await proxy).dispose();
}

/**
 * workerd を起こし、マイグレーションを流して、その形を覚える
 * @returns バインディングと dispose
 */
async function start(): Promise<{ env: Bindings; dispose: () => Promise<void> }> {
  const wire = await startWire();
  // 覚えた形は D1 の物ごとに引くので、同じ物を渡し続ける
  const { DB, REC_2026, REC_2027 } = wire.d1;
  await Promise.all([migrate(DB, "main"), migrate(REC_2026, "ledger"), migrate(REC_2027, "ledger")]);
  await Promise.all([remember(DB), remember(REC_2026), remember(REC_2027)]);
  return { env: { DB, REC_2026, REC_2027, FILES: wire.FILES }, dispose: () => wire.dispose() };
}

/**
 * マイグレーションを流した空の D1 と R2 を渡す。workerd はファイルで 1 つ起こし、2 回目からは中身をマイグレーションの直後に戻して渡す。テストごとに呼んでよい
 * @returns DB と REC_<年> と dispose。dispose は何もしない (workerd はファイルの終わりに止める)
 */
export async function createTestD1(): Promise<TestD1> {
  if (!shared) {
    shared = start();
    atFileEnd(stop);
  }
  const { env } = await shared;
  const { DB, REC_2026, REC_2027, FILES } = env;
  if (handedOut) await Promise.all([resetMain(DB), resetLedger(REC_2026), resetLedger(REC_2027), clear(FILES)]);
  handedOut = true;
  return { DB, REC_2026, REC_2027, FILES, dispose: () => Promise.resolve() };
}
