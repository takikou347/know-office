// Claude Code の PostToolUse フック。Edit と Write で書いた ts と tsx をその場で lint し、落ちた時だけ中身を Claude に返す
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAIL = 40;

/**
 * フックの入力から lint するファイルを選ぶ
 * @param input フックが標準入力で渡す JSON
 * @param root know-office の置き場
 * @returns リポジトリからの相対パス。lint しない時は undefined
 */
export function lintTarget(input: unknown, root: string): string | undefined {
  if (typeof input !== "object" || input === null || !("tool_input" in input)) {
    return undefined;
  }
  const toolInput: unknown = input.tool_input;
  if (typeof toolInput !== "object" || toolInput === null || !("file_path" in toolInput)) {
    return undefined;
  }
  const filePath: unknown = toolInput.file_path;
  if (typeof filePath !== "string" || !/\.tsx?$/.test(filePath)) {
    return undefined;
  }
  const rel = relative(root, resolve(root, filePath));
  const parts = rel.split("/");
  if (rel === "" || isAbsolute(rel) || parts[0] === ".." || parts.includes("node_modules")) {
    return undefined;
  }
  return rel;
}

/**
 * oxlint を走らせた結果をフックの返事にする。終わりのコード 2 で、文が Claude に返る
 * @param run `spawnSync` の結果
 * @returns 終わりのコードと Claude に返す文
 */
export function lintReport(run: { status: number | null; stdout: string; stderr: string; error?: Error }): { code: 0 | 2; message: string } {
  if (run.status === 0) {
    return { code: 0, message: "" };
  }
  if (run.status === null) {
    return { code: 2, message: `oxlint を走らせられない: ${run.error?.message ?? "不明"}` };
  }
  return { code: 2, message: `${run.stdout}${run.stderr}`.trimEnd().split("\n").slice(-TAIL).join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = lintTarget(JSON.parse(readFileSync(0, "utf8")) as unknown, root);
  if (target === undefined) {
    process.exit(0);
  }
  const report = lintReport(spawnSync("pnpm", ["exec", "oxlint", "--type-aware", "--deny-warnings", target], { cwd: root, encoding: "utf8" }));
  process.stderr.write(report.message);
  process.exit(report.code);
}
