// 要件のシナリオごとに、同じ名前の it か test があるかを突き合わせる。node scripts/scenarios.ts <要件の名前>... で一覧を出し、無ければ落ちる
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 要件の 1 つのシナリオ */
export type Scenario = { capability: string; requirement: string; scenario: string };

/** 突き合わせた 1 行。where はテストの置き場、残りなら「残り (タスク)」、無ければ「無い」 */
export type Row = Scenario & { where: string };

/**
 * テストがまだ作れないシナリオと、作るタスクの番号。作る物 (GitHub の通知の受け取り) が無いため
 */
export const PENDING: ReadonlyMap<string, string> = new Map([
  ["偽の通知", "8.3"],
  ["同じ通知が 2 度届く", "8.3"],
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "test-results", "playwright-report", ".git", ".claude"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const TEST_CALL = /\b(?:it|test)(?:\.(?!describe\b)\w+)?\(\s*(["'`])(.+?)\1/g;

/**
 * 1 つの要件の仕様から、要件とシナリオの名前を順に読む
 * @param root know-office の置き場
 * @param capability 要件の名前 (openspec/changes/build-office/specs/ の下のフォルダ)
 * @returns シナリオの並び
 */
export function readScenarios(root: string, capability: string): Scenario[] {
  const text = readFileSync(join(root, "openspec", "changes", "build-office", "specs", capability, "spec.md"), "utf8");
  const out: Scenario[] = [];
  let requirement = "";
  for (const line of text.split("\n")) {
    const req = /^### Requirement: (.+)$/.exec(line);
    if (req?.[1]) requirement = req[1].trim();
    const sc = /^#### Scenario: (.+)$/.exec(line);
    if (sc?.[1]) out.push({ capability, requirement, scenario: sc[1].trim() });
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
 * @param pending テストがまだ作れないシナリオと、作るタスクの番号
 * @returns 一覧の行、テストの無いシナリオ、テストができたのに残りに挙げたままのシナリオ
 */
export function matchScenarios(scenarios: Scenario[], names: ReadonlyMap<string, string[]>, pending: ReadonlyMap<string, string>) {
  const rows: Row[] = scenarios.map((s) => {
    const found = names.get(s.scenario);
    const task = pending.get(s.scenario);
    if (found) return { ...s, where: found.join("、") };
    return { ...s, where: task ? `残り (${task})` : "無い" };
  });
  return {
    rows,
    missing: rows.filter((row) => row.where === "無い"),
    stale: scenarios.filter((s) => names.has(s.scenario) && pending.has(s.scenario)).map((s) => s.scenario),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const capabilities = process.argv.slice(2);
  const result = matchScenarios(capabilities.flatMap((c) => readScenarios(root, c)), testNames(root), PENDING);
  const lines = ["| 要件 | シナリオ | テスト |", "| --- | --- | --- |", ...result.rows.map((r) => `| ${r.capability}: ${r.requirement} | ${r.scenario} | ${r.where} |`)];
  for (const row of result.missing) lines.push(`テストが無い: ${row.capability} の ${row.scenario}`);
  for (const name of result.stale) lines.push(`テストができたので PENDING から外す: ${name}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = result.missing.length === 0 && result.stale.length === 0 ? 0 : 1;
}
