// 毎日 4 時 (日本時間) に、wrangler.jsonc の本番の D1 を wrangler d1 export で書き出して R2 の FILES の backups/<置き場>/<日>.sql に置き、30 日より古い写しを消す。backup.yml が回す (ログインと記録の 3.6)
// https://developers.cloudflare.com/d1/best-practices/import-export-data/ の Known limitations: "A running export will block other database requests."
// 書き出しの間はその D1 への要求が止まるので、使われない 4 時に流し、記録は書き込みの続く今の年だけを毎日、readonly になった過去の年は月に 1 度だけ書き出す
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const office = join(root, "apps", "office");

/** wrangler に渡す引数を 1 回流し、標準出力を返す。テストは代わりを渡す */
export type Wrangler = (args: string[]) => string;

/** 書き出す D1 の結び目と名前 */
export type Database = { binding: string; name: string };

/** wrangler.jsonc のうち、写しに使う所 */
type Config = { d1_databases: { binding: string; database_name: string }[]; r2_buckets: { binding: string; bucket_name: string }[] };

/** 写しを残す日数。今日を入れて、この日数より前の写しを消す */
export const BACKUP_RETENTION_DAYS = 30;

/** 消す側の幅。毎日この日数分を消し直すので、1 日落ちても次の日に消える */
const PRUNE_WINDOW_DAYS = 7;

const DAY = 24 * 60 * 60_000;

/** 記録の D1 の結び目。年を取り出す */
const RECORD = /^REC_(\d{4})$/;

/** 名前に使ってよい文字。コマンドの引数と R2 のキーに入れる */
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * JSONC の行のコメントを外して wrangler.jsonc を読む。文字列の中に行の頭の // を含まない前提
 * @param path wrangler.jsonc の道
 * @returns 写しに使う所
 * @throws Error D1 か FILES の R2 が無い時
 */
export function readConfig(path: string): Config {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replaceAll(/^\s*\/\/.*$/gm, ""));
  if (typeof parsed !== "object" || parsed === null || !("d1_databases" in parsed) || !("r2_buckets" in parsed)) throw new Error("wrangler.jsonc に d1_databases か r2_buckets が無い");
  // 形は下の databases と bucketOf で 1 つずつ確かめる
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed as Config;
}

/**
 * 本番の D1 を結び目ごとに並べる。名前と結び目は決めた文字だけを受ける
 * @param config wrangler.jsonc
 * @returns 書き出す D1
 * @throws Error 形の違う名前がある時
 */
export function databases(config: Config): Database[] {
  return config.d1_databases.map((d) => {
    if (!SAFE.test(d.binding) || !SAFE.test(d.database_name)) throw new Error(`D1 の名前の形が違う: ${d.binding}`);
    return { binding: d.binding, name: d.database_name };
  });
}

/**
 * FILES の R2 のバケットの名前を返す
 * @param config wrangler.jsonc
 * @returns バケットの名前
 * @throws Error FILES が無いか名前の形が違う時
 */
export function bucketOf(config: Config): string {
  const name = config.r2_buckets.find((b) => b.binding === "FILES")?.bucket_name ?? "";
  if (!SAFE.test(name)) throw new Error("FILES の R2 が無い");
  return name;
}

/**
 * 日本時間の日を YYYY-MM-DD で返す
 * @param at 時刻
 * @returns 日
 */
export function jstDayOf(at: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(at));
}

/**
 * 日を n 日戻す
 * @param day YYYY-MM-DD
 * @param n 戻す日数
 * @returns YYYY-MM-DD
 */
function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
}

/**
 * その日に書き出すか。本番の DB と今の年の記録は毎日、readonly になった過去の年の記録は月の 1 日だけ、まだ来ない年は書き出さない
 * @param binding 結び目
 * @param day 日本時間の日
 * @returns 書き出すなら true
 */
function exportsOn(binding: string, day: string): boolean {
  const year = RECORD.exec(binding)?.[1];
  if (year === undefined) return true;
  const today = day.slice(0, 4);
  if (year === today) return true;
  // 過去の年は書き換わらないので、月に 1 度で足りる。止まるのは読む要求だけ
  return year < today && day.endsWith("-01");
}

/**
 * 写しの手順を wrangler の引数の並びにする。その日に書き出す D1 ごとに、書き出してから R2 に置く
 * @param config wrangler.jsonc
 * @param day 日本時間の日
 * @param dir 書き出す一時の置き場
 * @returns wrangler の引数の並び
 */
export function backupPlan(config: Config, day: string, dir: string): string[][] {
  const bucket = bucketOf(config);
  return databases(config)
    .filter((d) => exportsOn(d.binding, day))
    .flatMap((d) => {
    const file = join(dir, `${d.binding}.sql`);
    return [
      // https://developers.cloudflare.com/workers/wrangler/commands/#d1-export
      ["d1", "export", d.name, "--remote", `--output=${file}`],
      // https://developers.cloudflare.com/workers/wrangler/commands/#r2-object-put
      ["r2", "object", "put", `${bucket}/backups/${d.binding}/${day}.sql`, `--file=${file}`, "--remote"],
    ];
  });
}

/**
 * 残す日数より古い写しを消す手順を作る。キーは日で決まるので、残す日数の次の日から PRUNE_WINDOW_DAYS 日分を消す
 * @param config wrangler.jsonc
 * @param day 日本時間の日
 * @returns wrangler の引数の並び
 */
export function prunePlan(config: Config, day: string): string[][] {
  const bucket = bucketOf(config);
  const days = Array.from({ length: PRUNE_WINDOW_DAYS }, (_, i) => daysBefore(day, BACKUP_RETENTION_DAYS + i));
  return databases(config).flatMap((d) =>
    // https://developers.cloudflare.com/workers/wrangler/commands/r2/ の r2 object delete。R2 に object の一覧のコマンドは無いので、日で決まるキーを消す
    days.map((old) => ["r2", "object", "delete", `${bucket}/backups/${d.binding}/${old}.sql`, "--remote"]),
  );
}

/**
 * その日の写しを置き終えてから古い写しを消す。写しは 1 つでも落ちたら投げ、消すのは落ちても続けて数を返す
 * @param wrangler wrangler を流す関数
 * @param plan 写しの手順
 * @param prune 消す手順
 * @returns 流した写しの手順の数と、消せなかった数
 */
export function runBackup(wrangler: Wrangler, plan: string[][], prune: string[][]): { steps: number; failedPrunes: number } {
  const steps = runPlan(wrangler, plan);
  let failedPrunes = 0;
  for (const args of prune) {
    try {
      wrangler(args);
    } catch {
      failedPrunes += 1;
    }
  }
  return { steps, failedPrunes };
}

/**
 * 写しの手順を順に流す。1 つでも落ちたら投げ、次の日に全部を取り直す
 * @param wrangler wrangler を流す関数
 * @param plan 手順
 * @returns 流した手順の数
 */
export function runPlan(wrangler: Wrangler, plan: string[][]): number {
  for (const args of plan) wrangler(args);
  return plan.length;
}

/**
 * apps/office で wrangler を流す。鍵は環境変数の CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID から wrangler が読み、引数とログに出さない
 * @param args 引数
 * @returns 標準出力
 */
export function localWrangler(args: string[]): string {
  return execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: office, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

// node scripts/backup.ts [--dry-run] で走らせた時だけ流す。--dry-run は手順を出すだけで Cloudflare に触らない
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readConfig(join(office, "wrangler.jsonc"));
  const dry = process.argv.includes("--dry-run");
  const dir = dry ? "<tmp>" : mkdtempSync(join(tmpdir(), "ko-backup-"));
  const day = jstDayOf(Date.now());
  const plan = backupPlan(config, day, dir);
  const prune = prunePlan(config, day);
  try {
    if (dry) {
      for (const args of [...plan, ...prune]) process.stdout.write(`wrangler ${args.join(" ")}\n`);
    } else {
      const result = runBackup(localWrangler, plan, prune);
      process.stdout.write(`${String(result.steps)} 手順を流し、古い写しを消すのに ${String(result.failedPrunes)} 件落ちた\n`);
      // 写しは置けているので、消せなかった事だけを落ちとして知らせる
      if (result.failedPrunes > 0) process.exitCode = 1;
    }
  } finally {
    if (!dry) rmSync(dir, { recursive: true, force: true });
  }
}
