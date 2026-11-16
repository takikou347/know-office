// CI の Check が、依存の弱点のチェックを依存を変えた PR と週に 1 度の main で、動く入口への自動の攻撃のチェックを PR ごとに回す事を確かめる (セキュリティの「弱点のチェック」)
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
    // 依存を変えた PR と、週に 1 度の main で回り、high 以上の弱点のある依存があれば落ちる
    assert.match(check, /^on:\n {2}pull_request:/m);
    assert.match(check, /^ {2}schedule:\n {4}- cron: "0 0 \* \* 1"$/m);
    const all = jobs(check);
    const steps = [...all.values()];
    const audit = steps.find((job) => /^ {6}- run: pnpm audit --audit-level high$/m.test(job));
    assert.ok(audit, "pnpm audit --audit-level high を走らせるジョブが無い");
    assert.match(audit, /^ {4}needs: changes\n {4}if: needs\.changes\.outputs\.deps == 'true'$/m);
    // 依存を変えたかは changes のジョブが決め、週に 1 度の時は必ず確かめる
    const changes = all.get("changes") ?? "";
    assert.match(changes, /^ {6}deps: \$\{\{ steps\.diff\.outputs\.deps \}\}$/m);
    assert.match(changes, /if \[ "\$EVENT" = "schedule" \]; then printf 'code=false\\ndeps=true\\n'/);
    const pattern = /deps=\$\(printf '%s\\n' "\$files" \| \{ grep -E '([^']+)'/.exec(changes)?.[1];
    assert.ok(pattern, "依存のファイルを選ぶ grep が無い");
    const deps = new RegExp(pattern);
    assert.deepEqual(
      ["pnpm-lock.yaml", "package.json", "apps/office/package.json", "packages/core/package.json", "apps/office/src/gate/app.ts", "README.md", "package.json.bak"].filter((f) => deps.test(f)),
      ["pnpm-lock.yaml", "package.json", "apps/office/package.json", "packages/core/package.json"],
    );
    // 週に 1 度の確かめで、ほかのジョブは回さない
    assert.match(all.get("check") ?? "", /^ {4}if: github\.event_name != 'schedule'$/m);
    // 動く入口への自動の攻撃は、画面の通しのジョブで 1 度だけ流す
    assert.ok(steps.some((job) => /^ {6}- run: pnpm e2e$/m.test(job)), "pnpm e2e を走らせるジョブが無い");
    // 攻撃はセッションを作るので、D1 のマイグレーション (records) の後に流す
    assert.match(playwright, /\{ name: "attack", testMatch: \/attack\\\.spec\\\.ts\/, dependencies: \["records", \.\.\.screenProjects\.map\(\(p\) => p\.name\)\] \}/);
    assert.ok(existsSync(join(root, "apps", "office", "e2e", "attack.spec.ts")));
  });
});
