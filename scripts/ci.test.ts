// CI の Check が、依存の弱点のチェックと動く入口への自動の攻撃のチェックを PR ごとに回す事を確かめる (セキュリティの「弱点のチェック」)
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = readFileSync(join(root, ".github", "workflows", "check.yml"), "utf8");
const playwright = readFileSync(join(root, "apps", "office", "playwright.config.ts"), "utf8");

/**
 * check.yml の jobs の下を、ジョブの名前ごとの文に分ける
 * @param text check.yml の中身
 * @returns ジョブの名前から、そのジョブの文への対応
 */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n"));
  const out = new Map<string, string>();
  for (const part of body.split(/\n(?= {2}[\w-]+:\n)/).slice(1)) {
    const name = /^ {2}([\w-]+):/.exec(part)?.[1];
    if (name) out.set(name, part);
  }
  return out;
}

void describe("弱点のチェック", () => {
  void it("弱点のあるコンポーネント", () => {
    // PR ごとに回り、high 以上の弱点のある依存があれば落ちる
    assert.match(check, /^on:\n {2}pull_request:/m);
    const steps = [...jobs(check).values()];
    assert.ok(steps.some((job) => /^ {6}- run: pnpm audit --audit-level high$/m.test(job)), "pnpm audit --audit-level high を走らせるジョブが無い");
    // 動く入口への自動の攻撃は、画面の通しのジョブで 1 度だけ流す
    assert.ok(steps.some((job) => /^ {6}- run: pnpm e2e$/m.test(job)), "pnpm e2e を走らせるジョブが無い");
    assert.match(playwright, /\{ name: "attack", testMatch: \/attack\\\.spec\\\.ts\/ \}/);
    assert.ok(existsSync(join(root, "apps", "office", "e2e", "attack.spec.ts")));
  });
});
