// 利用場面の通し (e2e/flows/) の Playwright のプロジェクトが、手元の D1 を同時に書かないよう 1 本ずつ流れる事を確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwright = readFileSync(join(root, "apps", "office", "playwright.config.ts"), "utf8");

/**
 * playwright.config.ts から、名前の合うプロジェクトの 1 行を読む
 * @param name プロジェクトの名前
 * @returns そのプロジェクトを書いた行
 */
function projectLine(name: string): string {
  const line = playwright.split("\n").find((l) => l.includes(`{ name: "${name}",`));
  assert.ok(line, `${name} のプロジェクトが無い`);
  return line;
}

void describe("利用場面の通しの流し方", () => {
  void it("通しと後始末は 1 本ずつ流し、手元の D1 を同時に書かない", () => {
    // 全体は fullyParallel なので、プロジェクトで上書きしないと同じファイルの 2 本が並んで走る。
    // 後始末の既読の要求と seedMain の wrangler が手元の D1 を同時に書くと、入口が塞がりで 500 を返す (#261)
    for (const name of ["flows", "flows-cleanup"]) {
      const line = projectLine(name);
      assert.match(line, /fullyParallel: false/, `${name} が並んで走る`);
      assert.match(line, /workers: 1\b/, `${name} が並んで走る`);
    }
  });
});
