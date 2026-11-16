// テスト設計 (knowidea) の要件のシナリオごとに、同じ名前の it か test があるかを突き合わせる。
// node scripts/scenarios.ts [文書の名前]... で一覧を出し、無ければ落ちる。knowidea が無い所 (CI) では飛ばす
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knowideaDir } from "./verify.ts";

/** 要件の 1 つのシナリオ。doc はテスト設計の機能の文書の名前 (例 4-guard) */
export type Scenario = { doc: string; requirement: string; scenario: string };

/** 突き合わせた 1 行。where はテストの置き場、無ければ「無い」 */
export type Row = Scenario & { where: string };

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "test-results", "playwright-report", ".git", ".claude"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const TEST_CALL = /\b(?:it|test)(?:\.(?!describe\b)\w+)?\(\s*(["'`])(.+?)\1/g;
const CHAPTER = /^## .*要件ごとのシナリオ/;
const REQUIREMENT = /^### (?:\d+(?:\.\d+)*\.? )?(.+?)\s*$/;
const ROW = /^\| (.+?) \|/;

/**
 * 文書の名前から置き場を求める
 * @param knowidea knowidea の置き場
 * @param name 文書の名前。05-test/ の機能ごとのテスト設計 (例 4-guard)
 * @returns 文書の道
 */
export function docPath(knowidea: string, name: string): string {
  return join(knowidea, "services", "know-office", "docs", "05-test", `${name}.md`);
}

/**
 * テスト設計の 1 つの文書の「要件ごとのシナリオ」の章から、要件とシナリオの名前を順に読む。
 * 章の中の節 (`### 2.1 <要件の名前>`) が要件で、節の表の 1 列目がシナリオの名前
 * @param file 文書の道
 * @returns シナリオの並び
 */
export function readScenarios(file: string): Scenario[] {
  const doc = basename(file, ".md");
  const out: Scenario[] = [];
  let inside = false;
  let requirement = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      inside = CHAPTER.test(line);
      requirement = "";
      continue;
    }
    if (!inside) continue;
    if (line.startsWith("### ")) {
      requirement = REQUIREMENT.exec(line)?.[1] ?? "";
      continue;
    }
    const scenario = requirement ? ROW.exec(line)?.[1]?.trim() : undefined;
    if (!scenario || scenario === "シナリオ" || scenario.startsWith("---")) continue;
    out.push({ doc, requirement, scenario });
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
 * @param names 文書の名前。空なら 05-test/ の index.md のほかの文書を全部
 * @returns 出す文と終わりのコード
 */
function report(root: string, knowidea: string, names: string[]): { text: string; code: number } {
  if (!existsSync(knowidea)) return { text: `knowidea が ${knowidea} に無いので飛ばす。KNOWIDEA_DIR で置き場を渡す`, code: 0 };
  const dir = dirname(docPath(knowidea, "x"));
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md").map((f) => basename(f, ".md")) : [];
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
