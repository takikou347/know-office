// push の前のチェックを全部走らせ、通った手順は 1 行、落ちた手順は出力の最後だけを出す。Claude の読む量を減らすため
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAIL = 40;

/** 走らせる手順。名前のほかは走らせ方による */
export type Step = { name: string };

/** 1 つの手順を走らせた結果。seconds はかかった秒 */
export type StepResult = { code: number; output: string; seconds?: number };

/** シェルで走らせる手順 */
export type ShellStep = Step & { cmd: string; cwd: string };

/**
 * 1 つの手順の結果を短い文にする。かかった秒があれば名前の後に付け、遅い手順を見つけられるようにする
 * @param result 手順の名前、終わりのコード、出力、かかった秒
 * @returns 通った時は 1 行、落ちた時は見出しと出力の最後の 40 行
 */
export function summarize(result: Step & StepResult): string {
  const took = result.seconds === undefined ? "" : ` (${Math.round(result.seconds)}s)`;
  if (result.code === 0) {
    return `ok   ${result.name}${took}`;
  }
  const head = `FAIL ${result.name}${took} (exit ${result.code})`;
  // 画面の通しの開発サーバーの出力 ([WebServer]) は失敗の理由を押し流すので外す
  const output = result.output
    .split("\n")
    .filter((line) => !line.startsWith("[WebServer]"))
    .join("\n")
    .trimEnd();
  return output === "" ? head : [head, ...output.split("\n").slice(-TAIL)].join("\n");
}

/**
 * 手順を順にすべて走らせ、まとめた文と落ちた数を返す
 * @param steps 走らせる手順
 * @param exec 1 つの手順を走らせる関数
 * @returns まとめた文と落ちた手順の数
 */
export function runSteps<S extends Step>(steps: S[], exec: (step: S) => StepResult): { text: string; failed: number } {
  const results = steps.map((step) => ({ name: step.name, ...exec(step) }));
  return {
    text: results.map(summarize).join("\n"),
    failed: results.filter((result) => result.code !== 0).length,
  };
}

/**
 * 手順をシェルで走らせ、標準出力と標準エラーをまとめて返す
 * @param step 名前、命令、走らせる場所
 * @returns 終わりのコード、出力、かかった秒
 */
function shell(step: ShellStep): StepResult {
  const started = performance.now();
  const run = spawnSync(step.cmd, { cwd: step.cwd, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: run.status ?? 1, output: `${run.stdout}${run.stderr}`, seconds: (performance.now() - started) / 1000 };
}

/**
 * 作業ツリーごとに e2e の入口の待ち受けの番号を決める。代わりの物は次の番号を使う (playwright.config.ts)。
 * 別の作業ツリーと同時に流しても、ポートと開発サーバーを取り合わない
 * @param root know-office の置き場
 * @returns 5200 から 5798 の偶数
 */
export function e2ePortFor(root: string): number {
  const hash = createHash("sha256").update(root).digest().readUInt32BE(0);
  return 5200 + 2 * (hash % 300);
}

/**
 * git の共通の置き場 (メインのチェックアウトの .git) を聞く
 * @param root know-office の置き場
 * @returns 共通の置き場の絶対の道。git で聞けなければ undefined
 */
function gitCommonDir(root: string): string | undefined {
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

/**
 * knowidea の置き場を決める。作業ツリーの中からでも、メインのチェックアウトの隣を見る
 * @param root know-office の置き場
 * @param env 環境変数。`KNOWIDEA_DIR` があればそれを先に使う
 * @param commonDir git の共通の置き場を聞く関数
 * @returns knowidea の置き場
 */
export function knowideaDir(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  commonDir: (root: string) => string | undefined = gitCommonDir,
): string {
  if (env.KNOWIDEA_DIR) return resolve(env.KNOWIDEA_DIR);
  const common = commonDir(root);
  const main = common === undefined ? root : dirname(resolve(root, common));
  return join(dirname(main), "knowidea");
}

/**
 * 走らせる手順を並べる
 * @param root know-office の置き場
 * @param argv 命令の引数。`--e2e` で画面のテストを足す
 * @param env 環境変数。`KNOWIDEA_DIR` で knowidea の置き場を渡す。無ければメインのチェックアウトの隣の knowidea
 * @param commonDir git の共通の置き場を聞く関数
 * @returns 走らせる手順
 */
export function stepsFor(
  root: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  commonDir: (root: string) => string | undefined = gitCommonDir,
): ShellStep[] {
  const knowidea = knowideaDir(root, env, commonDir);
  const check = join(knowidea, "tools", "check.py");
  const steps: ShellStep[] = [
    { name: "lint", cmd: "pnpm lint", cwd: root },
    { name: "typecheck", cmd: "pnpm typecheck", cwd: root },
    { name: "test", cmd: "pnpm test", cwd: root },
    { name: "build", cmd: "pnpm build", cwd: root },
    existsSync(check)
      ? { name: "check.py", cmd: `python3 ${JSON.stringify(check)} ${JSON.stringify(root)}`, cwd: dirname(knowidea) }
      : { name: "check.py", cmd: `echo "knowidea が ${knowidea} に無い。KNOWIDEA_DIR で置き場を渡す" && exit 1`, cwd: root },
    {
      name: "routes",
      cmd: `python3 ${JSON.stringify(join(knowidea, "tools", "routes_md.py"))} --check ${JSON.stringify(join(root, "apps", "office", "openapi", "v1.yaml"))}`,
      cwd: root,
    },
  ];
  if (argv.includes("--e2e")) {
    steps.push({ name: "e2e", cmd: `E2E_PORT=${e2ePortFor(root)} pnpm e2e`, cwd: root });
  }
  return steps;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = runSteps(stepsFor(root, process.argv.slice(2), process.env), shell);
  process.stdout.write(`${result.text}\n`);
  process.exitCode = result.failed === 0 ? 0 : 1;
}
