// 1 日前に戻す練習 (restore-drill.ts と restore-drill.yml) が、本物の置き場を使わずに、時点の戻しと戻し直しと行の数の比べを決めた順に行う事を確かめる (ログインと記録の 3.6)
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DRILL_DATABASE, drillPlan, restoreDrill } from "./restore-drill.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 11, 1, 20, 0, 0);

/** 代わりの D1 の中身。表ごとの行の時刻 */
type Tables = Record<string, number[]>;

/**
 * 時点の戻しを持つ代わりの D1 を、wrangler の引数で動かす。1 日前の時点は day の中身で、元の時点は now の中身
 * @param now 今の中身
 * @param day 1 日前の時点の中身
 * @returns wrangler の代わりと、流した引数と、今の中身を読む関数
 */
function fakeD1(now: Tables, day: Tables) {
  let current = now;
  const calls: string[][] = [];
  const wrangler = (args: string[]): string => {
    calls.push(args);
    const [group, verb, sub] = args;
    if (group === "d1" && verb === "execute") {
      const sql = args.find((a) => a.startsWith("--command="))?.slice("--command=".length) ?? "";
      if (sql.includes("sqlite_master")) return JSON.stringify([{ results: Object.keys(current).map((name) => ({ name })) }]);
      const rows = [...sql.matchAll(/SELECT '(\w+)' AS name, count\(\*\) AS n FROM "(\w+)"(?: WHERE at < (\d+))?/g)].map((m) => {
        const cutoff = m[3] === undefined ? Infinity : Number(m[3]);
        return { name: m[1], n: (current[m[2] ?? ""] ?? []).filter((at) => at < cutoff).length };
      });
      return JSON.stringify([{ results: rows, success: true }]);
    }
    if (group === "d1" && verb === "time-travel" && sub === "info") return JSON.stringify({ bookmark: "b-day" });
    if (group === "d1" && verb === "time-travel" && sub === "restore") {
      const to = args.find((a) => a.startsWith("--bookmark="))?.slice("--bookmark=".length);
      const previous = current === now ? "b-now" : "b-day";
      current = to === "b-day" ? day : now;
      return JSON.stringify({ bookmark: to, previous_bookmark: previous, message: "restored" });
    }
    throw new Error(`知らないコマンド ${args.join(" ")}`);
  };
  return { wrangler, calls, current: () => current };
}

const OLD = [NOW - 3 * DAY, NOW - 2 * DAY];
const NEW = [NOW - 60_000];

void describe("記録を戻せる", () => {
  void it("1 日前に戻す", () => {
    const d1 = fakeD1({ audit_log: [...OLD, ...NEW], usage: [OLD[0] ?? 0] }, { audit_log: [...OLD], usage: [OLD[0] ?? 0] });
    const result = restoreDrill(d1.wrangler, { database: DRILL_DATABASE, now: NOW });
    assert.deepEqual(result, { ok: true, detail: "2 表を 1 日前に戻せた" });
    // 1 日前の時点を取り、戻し、確かめた後に元の時点へ戻し直す
    const travel = d1.calls.filter((c) => c[1] === "time-travel").map((c) => c.slice(2).join(" "));
    assert.deepEqual(travel, [
      `info ${DRILL_DATABASE} --timestamp=${new Date(NOW - DAY).toISOString()} --json`,
      `restore ${DRILL_DATABASE} --bookmark=b-day --json`,
      `restore ${DRILL_DATABASE} --bookmark=b-now --json`,
    ]);
    assert.equal(d1.current().audit_log?.length, 3);
    // どの手順も本番の置き場に触らない
    assert.ok(d1.calls.every((c) => c.includes(DRILL_DATABASE)));
  });

  void it("戻した時点で 1 日前より古い行が欠けていれば落とし、それでも元の時点へ戻し直す", () => {
    const d1 = fakeD1({ audit_log: [...OLD, ...NEW] }, { audit_log: [OLD[0] ?? 0] });
    const result = restoreDrill(d1.wrangler, { database: DRILL_DATABASE, now: NOW });
    assert.deepEqual(result, { ok: false, detail: "1 日前に戻した後の行の数が合わない: audit_log" });
    assert.deepEqual(d1.calls.at(-2), ["d1", "time-travel", "restore", DRILL_DATABASE, "--bookmark=b-now", "--json"]);
    assert.equal(d1.current().audit_log?.length, 3);
  });

  void it("表の名前の形が違えば、SQL に入れずに戻さない", () => {
    const d1 = fakeD1({ "audit_log; DROP": [...OLD] }, {});
    assert.deepEqual(restoreDrill(d1.wrangler, { database: DRILL_DATABASE, now: NOW }), { ok: false, detail: "記録の表が無いか、表の名前の形が違う" });
    assert.ok(d1.calls.every((c) => c[1] === "execute"));
  });

  void it("wrangler の答えに戻す前の bookmark が無ければ、確かめずに落とす", () => {
    const d1 = fakeD1({ audit_log: [...OLD] }, { audit_log: [...OLD] });
    const broken = (args: string[]) => (args[2] === "restore" ? JSON.stringify({ message: "restored" }) : d1.wrangler(args));
    assert.throws(() => restoreDrill(broken, { database: DRILL_DATABASE, now: NOW }), /previous_bookmark/);
  });
});

void describe("restore-drill.yml", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "restore-drill.yml"), "utf8");

  void it("毎月 1 回回り、鍵は env にだけ置き、権限は contents: read だけ", () => {
    assert.match(workflow, /^ {4}- cron: "0 20 1 \* \*"$/m);
    assert.match(workflow, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(workflow, /run:[^\n]*secrets\./);
    assert.match(workflow, / {6}CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  });

  void it("鍵が無い間は飛ばさず、手順を出す dry-run を流す", () => {
    assert.match(workflow, /node scripts\/restore-drill\.ts --dry-run/);
    assert.match(workflow, /node scripts\/restore-drill\.ts\n/);
    assert.deepEqual(drillPlan(DRILL_DATABASE).length, 5);
  });
});
