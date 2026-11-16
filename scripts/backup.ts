// 毎日 4 時 (日本時間) に、wrangler.jsonc の全部の D1 を wrangler d1 export で書き出し、R2 の FILES の backups/<置き場>/<日>.sql に置く。backup.yml が回す (ログインと記録の 3.6)
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
 * 写しの手順を wrangler の引数の並びにする。D1 ごとに書き出してから R2 に置く
 * @param config wrangler.jsonc
 * @param day 日本時間の日
 * @param dir 書き出す一時の置き場
 * @returns wrangler の引数の並び
 */
export function backupPlan(config: Config, day: string, dir: string): string[][] {
  const bucket = bucketOf(config);
  return databases(config).flatMap((d) => {
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
  const plan = backupPlan(config, jstDayOf(Date.now()), dir);
  try {
    if (dry) for (const args of plan) process.stdout.write(`wrangler ${args.join(" ")}\n`);
    else process.stdout.write(`${String(runPlan(localWrangler, plan))} 手順を流した\n`);
  } finally {
    if (!dry) rmSync(dir, { recursive: true, force: true });
  }
}
