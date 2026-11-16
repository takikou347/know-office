// 毎月 1 回、プレビュー用の記録の D1 を D1 の時点の戻し (Time Travel) で 1 日前に戻し、1 日前より古い行の数が合うかを確かめ、元の時点に戻し直す。restore-drill.yml が回す (ログインと記録の 3.6)
import { fileURLToPath } from "node:url";
import { localWrangler, type Wrangler } from "./backup.ts";

/** 戻す練習に使う置き場。本番の置き場は戻さない (wrangler.jsonc の previews の REC_*) */
export const DRILL_DATABASE = "know-office-preview-rec";

const DAY = 24 * 60 * 60_000;

/** 表の名前に使ってよい文字。SQL に入れる */
const TABLE = /^[a-z_]{1,64}$/;

/** 練習の結果 */
export type DrillResult = { ok: boolean; detail: string };

/**
 * wrangler の --json の答えを読む
 * @param text 標準出力
 * @returns 読んだ値
 */
function json(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * 値から文字列の項目を読む
 * @param value 読む値
 * @param key 項目の名前
 * @returns 文字列。無ければ投げる
 * @throws Error 項目が無いか文字列でない時
 */
function stringField(value: unknown, key: string): string {
  const found: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof found !== "string" || found === "") throw new Error(`wrangler の答えに ${key} が無い`);
  return found;
}

/**
 * SQL を 1 文流し、行を返す
 * @param wrangler wrangler を流す関数
 * @param database 置き場
 * @param sql 流す SQL
 * @returns 行
 * @throws Error 答えの形が違う時
 */
function query(wrangler: Wrangler, database: string, sql: string): Record<string, unknown>[] {
  // https://developers.cloudflare.com/workers/wrangler/commands/#d1-execute の --json は文ごとの { results } の並び
  const answer = json(wrangler(["d1", "execute", database, "--remote", "--json", `--command=${sql}`]));
  const first: unknown = Array.isArray(answer) ? answer[0] : undefined;
  const results: unknown = typeof first === "object" && first !== null ? Reflect.get(first, "results") : undefined;
  if (!Array.isArray(results)) throw new Error("wrangler d1 execute の答えの形が違う");
  return results.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
}

/**
 * 表ごとの行の数を数える。cutoff を渡すとその時刻より前の行だけを数える
 * @param wrangler wrangler を流す関数
 * @param database 置き場
 * @param tables 表の名前
 * @param cutoff 時刻 (協定世界時のミリ秒)
 * @returns 表の名前から行の数への対応
 */
function counts(wrangler: Wrangler, database: string, tables: string[], cutoff?: number): Record<string, number> {
  const where = cutoff === undefined ? "" : ` WHERE at < ${String(Math.floor(cutoff))}`;
  const sql = tables.map((t) => `SELECT '${t}' AS name, count(*) AS n FROM "${t}"${where}`).join(" UNION ALL ");
  return Object.fromEntries(query(wrangler, database, sql).map((r) => [String(r.name), Number(r.n)]));
}

/**
 * 1 日前に戻す練習をする。戻した後に 1 日前より古い行の数が合うか、全体の行が増えていないかを確かめ、確かめが落ちても元の時点へ戻し直す
 * @param wrangler wrangler を流す関数
 * @param options 置き場と今の時刻
 * @param options.database 置き場
 * @param options.now 今の時刻
 * @returns 合ったかと、その中身
 */
export function restoreDrill(wrangler: Wrangler, options: { database: string; now: number }): DrillResult {
  const { database, now } = options;
  const tables = query(wrangler, database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name").map((r) =>
    String(r.name),
  );
  if (tables.length === 0 || tables.some((t) => !TABLE.test(t))) return { ok: false, detail: "記録の表が無いか、表の名前の形が違う" };
  const cutoff = now - DAY;
  const olderBefore = counts(wrangler, database, tables, cutoff);
  const totalBefore = counts(wrangler, database, tables);
  // https://developers.cloudflare.com/d1/reference/time-travel/ の info で時点の bookmark を取り、restore はその前の bookmark を返す
  const dayAgo = stringField(json(wrangler(["d1", "time-travel", "info", database, `--timestamp=${new Date(cutoff).toISOString()}`, "--json"])), "bookmark");
  const undo = stringField(json(wrangler(["d1", "time-travel", "restore", database, `--bookmark=${dayAgo}`, "--json"])), "previous_bookmark");
  let result: DrillResult;
  try {
    const olderAfter = counts(wrangler, database, tables, cutoff);
    const totalAfter = counts(wrangler, database, tables);
    const mismatched = tables.filter((t) => olderAfter[t] !== olderBefore[t] || (totalAfter[t] ?? 0) > (totalBefore[t] ?? 0));
    result = mismatched.length === 0 ? { ok: true, detail: `${String(tables.length)} 表を 1 日前に戻せた` } : { ok: false, detail: `1 日前に戻した後の行の数が合わない: ${mismatched.join("、")}` };
  } finally {
    // 練習の後は必ず元の時点に戻す。戻せなければ投げて落とす
    wrangler(["d1", "time-travel", "restore", database, `--bookmark=${undo}`, "--json"]);
  }
  const totalBack = counts(wrangler, database, tables);
  const lost = tables.filter((t) => totalBack[t] !== totalBefore[t]);
  if (lost.length > 0) return { ok: false, detail: `元の時点に戻し直した後の行の数が合わない: ${lost.join("、")}` };
  return result;
}

/**
 * 練習で流す手順を、時点の値を印にして並べる。鍵が無い時に出す
 * @param database 置き場
 * @returns wrangler の引数の並び
 */
export function drillPlan(database: string): string[] {
  return [
    `d1 execute ${database} --remote --json --command=<表ごとの行の数>`,
    `d1 time-travel info ${database} --timestamp=<1 日前> --json`,
    `d1 time-travel restore ${database} --bookmark=<1 日前の bookmark> --json`,
    `d1 execute ${database} --remote --json --command=<表ごとの行の数>`,
    `d1 time-travel restore ${database} --bookmark=<戻す前の bookmark> --json`,
  ];
}

// node scripts/restore-drill.ts [--dry-run] で走らせた時だけ流す。--dry-run は手順を出すだけで Cloudflare に触らない
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--dry-run")) {
    for (const line of drillPlan(DRILL_DATABASE)) process.stdout.write(`wrangler ${line}\n`);
  } else {
    const result = restoreDrill(localWrangler, { database: DRILL_DATABASE, now: Date.now() });
    process.stdout.write(`${result.detail}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
