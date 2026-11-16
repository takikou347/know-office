// 毎日の D1 の写し (backup.ts と backup.yml) が、wrangler.jsonc の全部の本番の D1 を、日本時間の日の名前で R2 の backups/ に置く手順を作る事を確かめる (ログインと記録の 3.6)
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKUP_RETENTION_DAYS, backupPlan, bucketOf, databases, jstDayOf, prunePlan, readConfig, runBackup, runPlan } from "./backup.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = readConfig(join(root, "apps", "office", "wrangler.jsonc"));

/**
 * その日に書き出す D1 の名前を並べる
 * @param day 日本時間の日
 * @returns D1 の名前
 */
function exported(day: string): (string | undefined)[] {
  return backupPlan(config, day, "/tmp/w")
    .filter((a) => a[1] === "export")
    .map((a) => a[2]);
}

void describe("毎日の D1 の写し", () => {
  void it("本番の D1 と今の年の記録を毎日書き出し、FILES の backups/<置き場>/<日>.sql に置く", () => {
    // 日本時間の 4 時は協定世界時の前の日の 19 時。日は日本時間で決める
    const day = jstDayOf(Date.UTC(2026, 10, 16, 19, 0, 0));
    assert.equal(day, "2026-11-17");
    const names = databases(config);
    assert.deepEqual(
      names.map((d) => d.binding),
      ["DB", "REC_2026", "REC_2027", "REC_2028", "REC_2029", "REC_2030", "REC_2031"],
    );
    // プレビューの置き場は写さない
    assert.ok(names.every((d) => !d.name.includes("preview")));
    assert.equal(bucketOf(config), "know-office-files");
    // まだ来ない年は空なので書き出さない
    assert.deepEqual(backupPlan(config, day, "/tmp/w"), [
      ["d1", "export", "know-office", "--remote", "--output=/tmp/w/DB.sql"],
      ["r2", "object", "put", "know-office-files/backups/DB/2026-11-17.sql", "--file=/tmp/w/DB.sql", "--remote"],
      ["d1", "export", "know-office-rec-2026", "--remote", "--output=/tmp/w/REC_2026.sql"],
      ["r2", "object", "put", "know-office-files/backups/REC_2026/2026-11-17.sql", "--file=/tmp/w/REC_2026.sql", "--remote"],
    ]);
  });

  void it("readonly になった過去の年の記録は、月の 1 日にだけ書き出す", () => {
    assert.deepEqual(exported("2027-01-01"), ["know-office", "know-office-rec-2026", "know-office-rec-2027"]);
    assert.deepEqual(exported("2027-01-02"), ["know-office", "know-office-rec-2027"]);
    assert.deepEqual(exported("2027-02-01"), ["know-office", "know-office-rec-2026", "know-office-rec-2027"]);
  });

  void it(`${String(BACKUP_RETENTION_DAYS)} 日より古い写しを消す`, () => {
    assert.equal(BACKUP_RETENTION_DAYS, 30);
    const prune = prunePlan(config, "2026-11-17");
    // 今日を入れて 30 日分を残し、その前の 1 週間を毎日消す。1 日落ちても次の日に消える
    const keys = prune.filter((a) => a[3]?.includes("/backups/DB/")).map((a) => a[3]);
    assert.deepEqual(keys, ["2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12"].map((d) => `know-office-files/backups/DB/${d}.sql`));
    assert.deepEqual(prune[0], ["r2", "object", "delete", "know-office-files/backups/DB/2026-10-18.sql", "--remote"]);
    // 過去の年と先の年の写しも同じ日で消す
    assert.equal(prune.length, databases(config).length * 7);
    // 残す日は消さない
    assert.ok(prune.every((a) => !a[3]?.includes("2026-10-19") && !a[3]?.includes("2026-11-17")));
  });

  void it("古い写しを消すのに落ちても、その日の写しは先に置き終え、落ちた数を返す", () => {
    const seen: string[] = [];
    const wrangler = (args: string[]) => {
      seen.push(args.slice(0, 3).join(" "));
      if (args[2] === "delete" && seen.filter((s) => s.endsWith("delete")).length === 1) throw new Error("消せない");
      return "";
    };
    const result = runBackup(wrangler, backupPlan(config, "2026-11-17", "/tmp/w"), prunePlan(config, "2026-11-17"));
    assert.equal(result.failedPrunes, 1);
    assert.equal(result.steps, 4);
    assert.ok(seen.indexOf("r2 object delete") > seen.lastIndexOf("r2 object put"));
  });

  void it("1 つでも落ちたら投げ、後の手順を流さない", () => {
    const seen: string[] = [];
    const plan = backupPlan(config, "2027-01-01", "/tmp/w");
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
  });

  void it("写し専用の鍵を使い、その権限を書いておく", () => {
    assert.match(workflow, / {6}CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_BACKUP_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.match(workflow, /# CLOUDFLARE_BACKUP_TOKEN の権限: [^\n]*D1[^\n]*R2/);
  });

  void it("鍵が無い間は飛ばさず、手順を出す dry-run を流す", () => {
    assert.match(workflow, /node scripts\/backup\.ts --dry-run/);
    assert.match(workflow, /node scripts\/backup\.ts\n/);
  });
});
