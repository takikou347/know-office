// 詳細設計 (knowidea) の要件のシナリオごとに、同じ名前の it か test があるかを突き合わせる。
// node scripts/scenarios.ts [文書の名前]... で一覧を出し、無ければ落ちる。knowidea が無い所 (CI) では飛ばす
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knowideaDir } from "./verify.ts";

/** 要件の 1 つのシナリオ。doc は詳細設計の文書の名前 (例 6-guard) */
export type Scenario = { doc: string; requirement: string; scenario: string };

/** 突き合わせた 1 行。where はテストの置き場、無ければ「無い」 */
export type Row = Scenario & { where: string };

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "test-results", "playwright-report", ".git", ".claude"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const TEST_CALL = /\b(?:it|test)(?:\.(?!describe\b)\w+)?\(\s*(["'`])(.+?)\1/g;
const SECTION = /^#+ .*要件とシナリオ/;
const ROW = /^\| (.+?) \| (.*) \|$/;
const SCENARIO = /<br>\*\*(.+?)\*\*: /g;

/**
 * 文書の名前から置き場を求める
 * @param knowidea knowidea の置き場
 * @param name 文書の名前。`04-detail` は目次の文書、ほかは 04-detail/ の機能ごとの文書
 * @returns 文書の道
 */
export function docPath(knowidea: string, name: string): string {
  const docs = join(knowidea, "services", "know-office", "docs");
  return name === "04-detail" ? join(docs, "04-detail.md") : join(docs, "04-detail", `${name}.md`);
}

/**
 * 詳細設計の 1 つの文書の「要件とシナリオ」の章から、要件とシナリオの名前を順に読む。
 * 章の表は 1 行 1 要件で、1 列目が要件の名前、2 列目に `<br>**<シナリオの名前>**: ` でシナリオを並べる
 * @param file 文書の道
 * @returns シナリオの並び
 */
export function readScenarios(file: string): Scenario[] {
  const doc = basename(file, ".md");
  const out: Scenario[] = [];
  let inside = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("#")) inside = SECTION.test(line);
    const row = inside ? ROW.exec(line) : null;
    if (!row?.[1] || !row[2] || row[1] === "要件" || row[1].startsWith("---")) continue;
    const requirement = row[1].trim();
    for (const match of row[2].matchAll(SCENARIO)) {
      out.push({ doc, requirement, scenario: (match[1] ?? "").trim() });
    }
  }
  return out;
}

/**
 * テストのファイルを集める
 * @param dir 探す所
 * @returns テストのファイルの道
 */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : testFiles(join(dir, entry.name));
    return TEST_FILE.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

/**
 * テストのファイルから it と test の名前を拾う。describe は拾わない
 * @param root know-office の置き場
 * @returns テストの名前から、その名前のあるファイル (リポジトリからの道) への対応
 */
export function testNames(root: string): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const file of testFiles(root)) {
    const rel = relative(root, file);
    for (const match of readFileSync(file, "utf8").matchAll(TEST_CALL)) {
      const name = match[2] ?? "";
      const files = names.get(name) ?? [];
      if (!files.includes(rel)) files.push(rel);
      names.set(name, files);
    }
  }
  return names;
}

/**
 * シナリオとテストの名前を突き合わせる
 * @param scenarios シナリオの並び
 * @param names テストの名前から置き場への対応
 * @returns 一覧の行と、テストの無いシナリオ
 */
export function matchScenarios(scenarios: Scenario[], names: ReadonlyMap<string, string[]>) {
  const rows: Row[] = scenarios.map((s) => ({ ...s, where: names.get(s.scenario)?.join("、") ?? "無い" }));
  return { rows, missing: rows.filter((row) => row.where === "無い") };
}

/**
 * 突き合わせて一覧の文と終わりのコードを作る
 * @param root know-office の置き場
 * @param knowidea knowidea の置き場
 * @param names 文書の名前。空なら要件とシナリオの章のある文書を全部
 * @returns 出す文と終わりのコード
 */
function report(root: string, knowidea: string, names: string[]): { text: string; code: number } {
  if (!existsSync(knowidea)) return { text: `knowidea が ${knowidea} に無いので飛ばす。KNOWIDEA_DIR で置き場を渡す`, code: 0 };
  const all = ["04-detail", ...readdirSync(dirname(docPath(knowidea, "x"))).filter((f) => f.endsWith(".md")).map((f) => basename(f, ".md"))];
  const problems: string[] = [];
  const scenarios = (names.length > 0 ? names : all).flatMap((name) => {
    const file = docPath(knowidea, name);
    const found = existsSync(file) ? readScenarios(file) : [];
    if (found.length === 0 && names.length > 0) problems.push(`${name} に要件とシナリオが無い`);
    return found;
  });
  const result = matchScenarios(scenarios, testNames(root));
  problems.push(...result.missing.map((row) => `テストが無い: ${row.doc} の ${row.scenario}`));
  const table = ["| 要件 | シナリオ | テスト |", "| --- | --- | --- |", ...result.rows.map((r) => `| ${r.doc}: ${r.requirement} | ${r.scenario} | ${r.where} |`)];
  return { text: [...table, ...problems].join("\n"), code: problems.length === 0 ? 0 : 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = report(root, knowideaDir(root, process.env), process.argv.slice(2));
  process.stdout.write(`${result.text}\n`);
  process.exitCode = result.code;
}
