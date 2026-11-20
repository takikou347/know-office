// GitHub Actions のワークフローの文を、テストで確かめるために分けて読む道具。deploy.yml と rollback.yml とその雛形のテストが使う
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

/**
 * ワークフローの jobs の下を、ジョブの名前ごとの文に分ける
 * @param text ワークフローの中身
 * @returns ジョブの名前から、そのジョブの文への対応
 */
export function jobs(text: string): Map<string, string> {
  const at = text.indexOf("\njobs:\n");
  const out = new Map<string, string>();
  if (at < 0) return out;
  for (const part of text.slice(at).split(/\n(?= {2}[\w-]+:\n)/).slice(1)) {
    const name = /^ {2}([\w-]+):/.exec(part)?.[1];
    if (name) out.set(name, part);
  }
  return out;
}

/** ジョブの 1 つのステップの env と run */
export type Step = { env: Record<string, string>; run: string; text: string };

/**
 * ジョブの中から、名前か id で 1 つのステップを取り出す
 * @param job ジョブの文
 * @param key ステップの name か id
 * @returns ステップの env と run の命令。無ければ空
 */
export function step(job: string, key: string): Step {
  const lines = job.split("\n");
  const start = lines.findIndex((l) => l === `      - name: ${key}` || l === `      - id: ${key}`);
  if (start < 0) return { env: {}, run: "", text: "" };
  const end = lines.findIndex((l, i) => i > start && /^ {0,6}\S/.test(l));
  const body = lines.slice(start, end < 0 ? undefined : end);
  const env: Record<string, string> = {};
  const envAt = body.indexOf("        env:");
  if (envAt >= 0) {
    for (const line of body.slice(envAt + 1)) {
      const m = /^ {10}([A-Z_]+): (.+)$/.exec(line);
      if (!m) break;
      env[m[1] ?? ""] = m[2] ?? "";
    }
  }
  const runAt = body.indexOf("        run: |");
  const run = runAt >= 0 ? body.slice(runAt + 1).filter((l) => l.startsWith("          ") || l === "").map((l) => l.slice(10)).join("\n") : (/^ {8}run: (.+)$/m.exec(body.join("\n"))?.[1] ?? "");
  return { env, run, text: body.join("\n") };
}

/**
 * 文の中で、並べた印がこの順に出るかを確かめる
 * @param text 探す文
 * @param marks 印の並び
 */
export function inOrder(text: string, marks: readonly string[]): void {
  let from = 0;
  for (const mark of marks) {
    const at = text.indexOf(mark, from);
    assert.ok(at >= 0, `${mark} が ${marks.join(" → ")} の順に無い`);
    from = at + mark.length;
  }
}

/**
 * ステップの命令を bash で走らせる。GitHub の runner と同じく、出力の置き場を GITHUB_OUTPUT に渡す
 * @param run 命令
 * @param env 渡す環境変数
 * @returns 終わりのコードと出力
 */
export function bash(run: string, env: Record<string, string>): { status: number | null; out: string } {
  const result = spawnSync("bash", ["-e", "-c", run], { env: { PATH: process.env["PATH"] ?? "", ...env }, encoding: "utf8", timeout: 5000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/**
 * ジョブの中で、secrets を env に読むステップの name か id を順に並べる
 * @param job ジョブの文
 * @returns ステップの name か id の並び
 */
export function secretSteps(job: string): string[] {
  return job
    .split(/\n(?= {6}- )/)
    .filter((part) => part.startsWith("      - ") && part.includes("secrets."))
    .map((part) => /^ {6}- (?:name|id): (.+)$/m.exec(part)?.[1] ?? part);
}

/**
 * ワークフローの複数行の命令 (run: |) を、字下げを外して並べる
 * @param text ワークフローの中身
 * @returns 命令の並び
 */
export function blocks(text: string): string[] {
  return [...text.matchAll(/^( +)run: \|\n((?:\1 {2}.*\n?)+)/gm)].map((m) => (m[2] ?? "").replace(new RegExp(`^${m[1] ?? ""} {2}`, "gm"), ""));
}
