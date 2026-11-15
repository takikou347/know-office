// deploy.yml と wrangler.jsonc の previews が、デプロイの流れと鍵の扱いの決まりを守る事を確かめる (ログインと記録の 3.7、運用手順の 1 章と 2 章)
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploy = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");
const check = readFileSync(join(root, ".github", "workflows", "check.yml"), "utf8");

/**
 * ワークフローの jobs の下を、ジョブの名前ごとの文に分ける
 * @param text ワークフローの中身
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

/**
 * 文の中で、並べた印がこの順に出るかを確かめる
 * @param text 探す文
 * @param marks 印の並び
 */
function inOrder(text: string, marks: readonly string[]): void {
  let from = 0;
  for (const mark of marks) {
    const at = text.indexOf(mark, from);
    assert.ok(at >= 0, `${mark} が ${marks.join(" → ")} の順に無い`);
    from = at + mark.length;
  }
}

/**
 * JSONC のコメントを外して読む。文字列の中に // を含まない wrangler.jsonc を前提にする
 * @param path ファイルの道
 * @returns 読んだ値
 */
function readJsonc(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

const all = jobs(deploy);

void describe("自動のデプロイとプレビュー環境", () => {
  void it("Cloudflare の鍵が無い間はデプロイの job を回さない", () => {
    const ready = all.get("ready") ?? "";
    assert.match(ready, /^ {6}ok: \$\{\{ steps\.keys\.outputs\.ok \}\}$/m);
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) {
      assert.match(ready, new RegExp(`^ {10}${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, "m"));
    }
    const others = [...all.entries()].filter(([name]) => name !== "ready");
    assert.deepEqual(others.map(([name]) => name).toSorted(), ["check", "preview", "preview-delete", "production"]);
    for (const [name, job] of others) {
      assert.match(job, /^ {4}needs: (ready|\[ready, check\])$/m, `${name} が ready を待たない`);
      assert.match(job, /^ {4}if: needs\.ready\.outputs\.ok == 'true'( |$)/m, `${name} が鍵の有無を見ない`);
    }
  });

  void it("鍵の値をログに出さない", () => {
    // secrets は env にだけ置き、命令の文に直に書かない
    for (const line of deploy.split("\n").filter((l) => l.includes("secrets."))) {
      assert.match(line, /^ +[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/, line);
    }
    for (const line of deploy.split("\n").filter((l) => /\becho\b/.test(l))) {
      assert.doesNotMatch(line, /\$\{?(CLOUDFLARE_API_TOKEN|CF_ACCESS_CLIENT_SECRET|CLOUDFLARE_ACCOUNT_ID)\b/, line);
    }
    // 呼んだ check.yml には secrets を渡さない
    assert.doesNotMatch(deploy, /secrets: inherit/);
  });

  void it("権限は内容を読むだけにし、サードパーティの action を使うなら SHA で固定する", () => {
    assert.match(deploy, /^permissions:\n {2}contents: read\n\n/m);
    assert.doesNotMatch(deploy, /: write$/m);
    for (const uses of deploy.matchAll(/uses: (\S+)/g)) {
      assert.match(uses[1] ?? "", /^(actions\/[\w-]+@v\d+|\.\/\.github\/workflows\/[\w-]+\.yml|[\w-]+\/[\w.-]+@[0-9a-f]{40})$/, uses[0]);
    }
    // 呼ばれる側も同じ中身を回せる
    assert.match(check, /^ {2}workflow_call:$/m);
    assert.match(all.get("check") ?? "", /^ {4}uses: \.\/\.github\/workflows\/check\.yml$/m);
  });

  void it("main ではチェックの後にマイグレーション、デプロイ、確かめを回し、確かめが落ちたら戻す", () => {
    const production = all.get("production") ?? "";
    assert.match(production, /^ {4}needs: \[ready, check\]$/m);
    assert.match(production, /&& github\.event_name == 'push'$/m);
    inOrder(production, ["pnpm build", "wrangler d1 migrations apply", "wrangler deploy", "node scripts/smoke.ts", "wrangler rollback"]);
    assert.match(production, /^ {8}if: failure\(\) && steps\.deploy\.outcome == 'success'$/m);
    assert.match(production, /^ {6}cancel-in-progress: false$/m);
    assert.match(deploy, /^ {2}push:\n {4}branches: \[main\]$/m);
  });

  void it("プルリクエストごとにプレビュー用の置き場でプレビューを出して確かめ、閉じたら消す", () => {
    const preview = all.get("preview") ?? "";
    assert.match(preview, /^ {4}needs: \[ready, check\]$/m);
    // フォークからのプルリクエストには鍵を渡さない
    assert.match(preview, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/m);
    inOrder(preview, ["pnpm build", ".previews.d1_databases", "wrangler d1 migrations apply", 'wrangler preview --name "pr-$NUMBER"', "node scripts/smoke.ts"]);
    assert.doesNotMatch(preview, /-c wrangler\.jsonc/);
    assert.match(all.get("preview-delete") ?? "", /wrangler preview delete --name "pr-\$NUMBER"/);
  });

  void it("プレビューは本番と別の D1 と R2 を結ぶ", () => {
    type Store = { binding: string; database_name?: string; bucket_name?: string };
    type Config = { vars: Record<string, string>; d1_databases: Store[]; r2_buckets: Store[]; previews: { vars: Record<string, string>; d1_databases: Store[]; r2_buckets: Store[] } };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 下の比べで形の違いは落ちる
    const config = readJsonc(join(root, "apps", "office", "wrangler.jsonc")) as Config;
    const names = (stores: Store[]) => stores.map((s) => s.database_name ?? s.bucket_name ?? "");
    const bindings = (stores: Store[]) => stores.map((s) => s.binding).toSorted();
    // どの結び目もプレビューで差し替え、本番の置き場の名前を 1 つも使わない
    assert.deepEqual(bindings(config.previews.d1_databases), bindings(config.d1_databases));
    assert.deepEqual(bindings(config.previews.r2_buckets), bindings(config.r2_buckets));
    const production = new Set([...names(config.d1_databases), ...names(config.r2_buckets)]);
    for (const name of [...names(config.previews.d1_databases), ...names(config.previews.r2_buckets)]) {
      assert.ok(name.startsWith("know-office-preview"), name);
      assert.ok(!production.has(name), name);
    }
    assert.equal(config.previews.vars["ENVIRONMENT"], "preview");
    assert.equal(config.previews.vars["URGENT_SCAN"], "off");
  });
});
