// サービスのリポジトリに置く deploy.yml と rollback.yml の雛形が、know-office の頼み方と本番の守りに合う事を確かめる (サービスと拡張の 3.1 と 3.2、運用手順の 1 章と 2 章)
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bash, blocks, inOrder, jobs, secretSteps, step } from "./workflow-text.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templates = join(root, "templates", "workflows");

/**
 * 雛形を読む。無ければ空の文にして、確かめの側で落とす
 * @param name 雛形のファイルの名前
 * @returns 雛形の中身
 */
function template(name: string): string {
  const path = join(templates, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const deploy = template("deploy.yml");
const rollback = template("rollback.yml");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const deployJobs = jobs(deploy);
const ready = deployJobs.get("ready") ?? "";
const production = deployJobs.get("production") ?? "";
const guard = step(ready, "既定のブランチと確かめたコミットを確かめる");
const keys = step(ready, "keys");

void describe("サービスのリポジトリに置く deploy.yml の雛形", () => {
  void it("workflow_dispatch の sha だけで動き、入力と ref を env で渡す", () => {
    assert.ok(deploy, "templates/workflows/deploy.yml が無い");
    // 動くのは know-office か書ける人が手で動かした時だけ。push と PR では回らない
    assert.match(deploy, /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}sha:\n {8}description: .+\n {8}required: true\n {8}type: string\n\n/m);
    assert.doesNotMatch(deploy, /^ {2}(push|pull_request|pull_request_target|schedule|workflow_run):/m);
    // 入力は sha の 1 つだけ。know-office が送る inputs と同じ
    assert.deepEqual([...deploy.matchAll(/^ {6}(\w+):\n {8}description:/gm)].map((m) => m[1]), ["sha"]);
    // 入力と ref は env で渡し、命令の文に直に入れない
    assert.deepEqual(guard.env, { SHA: "${{ inputs.sha }}", REF: "${{ github.ref }}", DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" });
    for (const line of deploy.split("\n").filter((l) => l.includes("inputs.") || l.includes("github.event."))) {
      assert.match(line, /^ {10}[A-Z_]+: \$\{\{ (inputs\.sha|github\.event\.repository\.default_branch) \}\}$/, line);
    }
  });

  void it("ref が既定のブランチで、sha が 40 桁の 16 進で既定のブランチの先と同じ時だけ通す", () => {
    const run = (env: Record<string, string>) => bash(guard.run, { SHA, REF: "refs/heads/main", DEFAULT_BRANCH: "main", GITHUB_SHA: SHA, ...env }).status;
    assert.ok(guard.run, "ready に、既定のブランチと確かめたコミットを確かめるステップが無い");
    assert.equal(run({}), 0);
    // 既定のブランチの名前は main に決め打ちしない
    assert.equal(run({ REF: "refs/heads/trunk", DEFAULT_BRANCH: "trunk" }), 0);
    // 既定のブランチのほかのブランチとタグ
    assert.notEqual(run({ REF: "refs/heads/feature" }), 0);
    assert.notEqual(run({ REF: "refs/tags/main" }), 0);
    assert.notEqual(run({ REF: "refs/heads/main", DEFAULT_BRANCH: "" }), 0);
    // 頼んだ後に既定のブランチが進んだ
    assert.notEqual(run({ GITHUB_SHA: "f".repeat(40) }), 0);
    // 形の違う sha。GITHUB_SHA と同じでも出さない
    for (const bad of ["", SHA.slice(1), `${SHA}0`, SHA.toUpperCase(), `${SHA.slice(0, 39)}g`, `$(touch /tmp/x)${SHA}`, `${SHA}\n`]) {
      assert.notEqual(run({ SHA: bad, GITHUB_SHA: bad }), 0, JSON.stringify(bad));
    }
  });

  void it("鍵か SERVICE_URL が無ければ飛ばさずに落とし、値を出さない", () => {
    const all = { CLOUDFLARE_API_TOKEN: "token-value", CLOUDFLARE_ACCOUNT_ID: "account-value", SERVICE_URL: "https://svc.example.workers.dev" };
    assert.equal(bash(keys.run, all).status, 0);
    // どれが欠けても黙って飛ばさずに落とし、know-office が頼んだのに出ない事を runs に残す。名前だけを出し、値は出さない
    for (const name of Object.keys(all)) {
      const missing = bash(keys.run, { ...all, [name]: "" });
      assert.notEqual(missing.status, 0, name);
      assert.match(missing.out, new RegExp(name), name);
      assert.doesNotMatch(missing.out, /token-value|account-value|svc\.example/, name);
    }
    assert.deepEqual(keys.env, { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}", SERVICE_URL: "${{ vars.SERVICE_URL }}" });
  });

  void it("確かめの後に environment の production でリポジトリ名の Worker を出し、聞いて返らなければ戻す", () => {
    assert.deepEqual([...deployJobs.keys()], ["ready", "production"]);
    // 確かめが落ちれば ready が落ち、本番の job は回らない
    assert.match(production, /^ {4}needs: ready$/m);
    // environment の production で回すので、GitHub がデプロイ (task は deploy) と結果を残し、know-office が success を数える
    assert.match(production, /^ {4}environment:\n {6}name: production\n {6}url: \$\{\{ vars\.SERVICE_URL \}\}$/m);
    // 戻すのと同じ並びで 1 つずつ。途中で止めない
    assert.match(production, /^ {4}concurrency:\n {6}group: deploy-production\n {6}cancel-in-progress: false$/m);
    // 出す、聞く、落ちたら戻す、戻した先に聞く。Worker の名前はリポジトリ名 (様子を読むスクリプト名と同じ)
    inOrder(production, ["pnpm install --frozen-lockfile", "pnpm build", 'wrangler deploy --name "${GITHUB_REPOSITORY#*/}"', "curl", 'wrangler rollback --name "${GITHUB_REPOSITORY#*/}" --yes', "curl"]);
    assert.match(step(production, "rollback").text, /^ {8}if: failure\(\) && steps\.deploy\.outcome == 'success'$/m);
    assert.match(production, /^ {8}if: failure\(\) && steps\.rollback\.outcome == 'success'$/m);
    // 聞くのは出した後と戻した後の 2 回。返らない URL と待ち続ける URL を、通ったと見ない
    const curls = production.split("\n").filter((l) => /\bcurl\b/.test(l));
    assert.equal(curls.length, 2);
    for (const line of curls) {
      assert.match(line, / --fail /, line);
      assert.match(line, / --max-time \d+ /, line);
    }
  });

  void it("権限は内容を読むだけにし、鍵を env にだけ置く", () => {
    assert.match(deploy, /^permissions:\n {2}contents: read\n\n/m);
    assert.doesNotMatch(deploy, /: write$/m);
    for (const line of deploy.split("\n").filter((l) => l.includes("secrets."))) assert.match(line, /^ +[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/, line);
    assert.doesNotMatch(deploy, /secrets: inherit/);
    for (const uses of deploy.matchAll(/uses: (\S+)/g)) assert.match(uses[1] ?? "", /^actions\/[\w-]+@v\d+$/, uses[0]);
    assert.match(production, /persist-credentials: false/);
    // Cloudflare の鍵は、出すステップと戻すステップにだけ渡す。依存を入れるステップや build には渡さない
    assert.doesNotMatch(production, /^ {4}env:/m);
    assert.deepEqual(secretSteps(production), ["deploy", "rollback"]);
  });

  void it("複数行の命令は、落ちた所と無い変数で止める", () => {
    assert.deepEqual(blocks(deploy).filter((b) => !b.startsWith("set -eu\n")), []);
    assert.ok(blocks(deploy).length >= 2);
  });
});

void describe("サービスのリポジトリに置く rollback.yml の雛形", () => {
  const job = jobs(rollback).get("rollback") ?? "";

  void it("know-office が理由を入れて動かし、リポジトリ名の Worker を戻して task が rollback のデプロイを残す", () => {
    assert.ok(rollback, "templates/workflows/rollback.yml が無い");
    assert.match(rollback, /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}reason:\n {8}description: .+\n {8}required: true\n {8}type: string\n\n/m);
    assert.deepEqual([...rollback.matchAll(/^ {6}(\w+):\n {8}description:/gm)].map((m) => m[1]), ["reason"]);
    assert.deepEqual([...jobs(rollback).keys()], ["rollback"]);
    // リポジトリ名の Worker を 1 つ前に戻し、その後に task が rollback のデプロイと成功を残す
    inOrder(job, ['wrangler rollback --name "${GITHUB_REPOSITORY#*/}" --yes', 'task: "rollback"', "/deployments", "/statuses", "state=success"]);
    // デプロイの雛形と同じ並びに入り、重ねず、途中で止めない
    assert.match(job, /^ {4}concurrency:\n {6}group: deploy-production\n {6}cancel-in-progress: false$/m);
    // environment を付けると GitHub が task の deploy のデプロイを作り、戻した版を新しいデプロイとして数えるので付けない
    assert.doesNotMatch(job, /^ {4}environment:/m);
  });

  void it("既定のブランチのほかから動かした時は、依存を入れる前に落とす", () => {
    const ref = step(job, "既定のブランチを確かめる");
    assert.ok(ref.run, "rollback に、既定のブランチを確かめるステップが無い");
    // ほかのブランチの依存と命令に鍵を渡さないため、checkout より前に確かめる
    assert.match(job, /^ {4}steps:\n(?: {6}#.*\n)* {6}- name: 既定のブランチを確かめる\n/m);
    assert.deepEqual(ref.env, { REF: "${{ github.ref }}", DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" });
    const run = (env: Record<string, string>) => bash(ref.run, { REF: "refs/heads/main", DEFAULT_BRANCH: "main", ...env }).status;
    assert.equal(run({}), 0);
    assert.equal(run({ REF: "refs/heads/trunk", DEFAULT_BRANCH: "trunk" }), 0);
    assert.notEqual(run({ REF: "refs/heads/feature" }), 0);
    assert.notEqual(run({ REF: "refs/tags/main" }), 0);
    assert.notEqual(run({ DEFAULT_BRANCH: "" }), 0);
  });

  void it("Cloudflare の鍵が無ければ落とす", () => {
    const keyStep = step(job, "鍵がそろっているか");
    assert.equal(bash(keyStep.run, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }).status, 0);
    assert.notEqual(bash(keyStep.run, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "" }).status, 0);
    assert.notEqual(bash(keyStep.run, { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "a" }).status, 0);
  });

  void it("権限はデプロイを書くだけを足し、理由と鍵を命令の文に直に入れない", () => {
    assert.match(rollback, /^permissions:\n {2}contents: read\n\n/m);
    assert.match(job, /^ {4}permissions:\n {6}contents: read\n {6}deployments: write\n/m);
    assert.deepEqual([...rollback.matchAll(/^ +[\w-]+: write$/gm)].map((m) => m[0].trim()), ["deployments: write"]);
    // 理由と鍵は env で渡し、命令の文に直に入れない
    for (const line of rollback.split("\n").filter((l) => l.includes("inputs.") || l.includes("secrets."))) {
      assert.match(line, /^ +[A-Z_]+: \$\{\{ (inputs\.reason|secrets\.[A-Z_]+) \}\}$/, line);
    }
    for (const uses of rollback.matchAll(/uses: (\S+)/g)) assert.match(uses[1] ?? "", /^actions\/[\w-]+@v\d+$/, uses[0]);
    assert.match(job, /persist-credentials: false/);
    // Cloudflare の鍵は、確かめるステップと戻すステップにだけ渡す
    assert.doesNotMatch(job, /^ {4}env:/m);
    assert.deepEqual(secretSteps(job), ["鍵がそろっているか", "前のバージョンに戻す"]);
    assert.deepEqual(blocks(rollback).filter((b) => !b.startsWith("set -eu\n")), []);
  });
});
