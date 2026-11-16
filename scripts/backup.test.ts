// 毎日の D1 の写し (backup.ts と backup.yml) が、wrangler.jsonc の全部の本番の D1 を、日本時間の日の名前で R2 の backups/ に置く手順を作る事を確かめる (ログインと記録の 3.6)
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { backupPlan, bucketOf, databases, jstDayOf, readConfig, runPlan } from "./backup.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = readConfig(join(root, "apps", "office", "wrangler.jsonc"));

void describe("毎日の D1 の写し", () => {
  void it("本番の全部の D1 を書き出し、FILES の backups/<置き場>/<日>.sql に置く", () => {
    // 日本時間の 4 時は協定世界時の前の日の 19 時。日は日本時間で決める
    const day = jstDayOf(Date.UTC(2026, 10, 16, 19, 0, 0));
    assert.equal(day, "2026-11-17");
    const plan = backupPlan(config, day, "/tmp/w");
    const names = databases(config);
    assert.deepEqual(
      names.map((d) => d.binding),
      ["DB", "REC_2026", "REC_2027", "REC_2028", "REC_2029", "REC_2030", "REC_2031"],
    );
    // プレビューの置き場は写さない
    assert.ok(names.every((d) => !d.name.includes("preview")));
    assert.equal(bucketOf(config), "know-office-files");
    assert.deepEqual(plan.slice(0, 2), [
      ["d1", "export", "know-office", "--remote", "--output=/tmp/w/DB.sql"],
      ["r2", "object", "put", "know-office-files/backups/DB/2026-11-17.sql", "--file=/tmp/w/DB.sql", "--remote"],
    ]);
    assert.equal(plan.length, names.length * 2);
  });

  void it("1 つでも落ちたら投げ、後の手順を流さない", () => {
    const seen: string[] = [];
    const plan = backupPlan(config, "2026-11-17", "/tmp/w");
    const failing = (args: string[]) => {
      seen.push(args.slice(0, 3).join(" "));
      if (seen.length === 3) throw new Error("export に失敗");
      return "";
    };
    assert.throws(() => runPlan(failing, plan), /export に失敗/);
    assert.equal(seen.length, 3);
  });

  void it("名前の形が違う D1 は手順に入れずに断る", () => {
    assert.throws(() => backupPlan({ d1_databases: [{ binding: "DB", database_name: "x; rm -rf /" }], r2_buckets: [{ binding: "FILES", bucket_name: "b" }] }, "2026-11-17", "/tmp/w"), /形が違う/);
  });
});

void describe("backup.yml", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "backup.yml"), "utf8");

  void it("毎日 4 時 (日本時間) に回り、鍵は env にだけ置き、権限は contents: read だけ", () => {
    assert.match(workflow, /^ {4}- cron: "0 19 \* \* \*"$/m);
    assert.match(workflow, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(workflow, /run:[^\n]*secrets\./);
    assert.match(workflow, / {6}CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  });

  void it("鍵が無い間は飛ばさず、手順を出す dry-run を流す", () => {
    assert.match(workflow, /node scripts\/backup\.ts --dry-run/);
    assert.match(workflow, /node scripts\/backup\.ts\n/);
  });
});
