// scenarios.ts の、要件のシナリオとテストの名前を突き合わせる所を確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { matchScenarios, readScenarios, testNames } from "./scenarios.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 一時の置き場にファイルを並べる
 * @param files リポジトリからの道と中身
 * @returns 置き場
 */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scenarios-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const SPEC = [
  "## ADDED Requirements",
  "",
  "### Requirement: 見本の要件",
  "",
  "#### Scenario: 見本の要求",
  "",
  "- **WHEN** 証明が無い",
  "",
  "#### Scenario: 見本の人",
  "",
  "### Requirement: 見本のチェック",
  "",
  "#### Scenario: 見本の部品",
  "",
].join("\n");

void describe("要件のシナリオとテストを突き合わせる", () => {
  void it("仕様から要件の名前とシナリオの名前を順に読む", () => {
    const dir = repo({ "openspec/changes/build-office/specs/security/spec.md": SPEC });
    assert.deepEqual(readScenarios(dir, "security"), [
      { capability: "security", requirement: "見本の要件", scenario: "見本の要求" },
      { capability: "security", requirement: "見本の要件", scenario: "見本の人" },
      { capability: "security", requirement: "見本のチェック", scenario: "見本の部品" },
    ]);
  });

  void it("it と test の名前だけを拾い、describe や文の中の同じ言葉は拾わない", () => {
    const dir = repo({
      "apps/office/test/gate/a.test.ts": 'describe("見本の人", () => {\n  it("見本の要求", () => {});\n  // 見本の人\n});\n',
      "apps/office/e2e/b.spec.ts": 'test.describe("x", () => {\n  test(`見本の部品`, async () => {});\n});\n',
      "scripts/c.test.ts": "void it('並べた名前', () => {});\n",
      "apps/office/node_modules/x/d.test.ts": 'it("見本の人", () => {});\n',
      "apps/office/src/e.ts": 'it("見本の人", () => {});\n',
    });
    const names = testNames(dir);
    assert.deepEqual([...names.keys()].toSorted(), ["見本の要求", "並べた名前", "見本の部品"].toSorted());
    assert.deepEqual(names.get("見本の要求"), ["apps/office/test/gate/a.test.ts"]);
  });

  void it("テストの無いシナリオを、残りに挙げた物と分けて返す", () => {
    const scenarios = [
      { capability: "security", requirement: "r", scenario: "a" },
      { capability: "security", requirement: "r", scenario: "b" },
      { capability: "security", requirement: "r", scenario: "c" },
    ];
    const result = matchScenarios(scenarios, new Map([["a", ["x.test.ts"]]]), new Map([["b", "8.3"]]));
    assert.deepEqual(result.rows.map((row) => [row.scenario, row.where]), [["a", "x.test.ts"], ["b", "残り (8.3)"], ["c", "無い"]]);
    assert.deepEqual(result.missing.map((row) => row.scenario), ["c"]);
  });

  void it("残りに挙げたシナリオにテストができたら、残りから外すよう落とす", () => {
    const scenarios = [{ capability: "security", requirement: "r", scenario: "b" }];
    const result = matchScenarios(scenarios, new Map([["b", ["x.test.ts"]]]), new Map([["b", "8.3"]]));
    assert.deepEqual(result.stale, ["b"]);
  });

  void it("security と auto-stop のシナリオは、残りに挙げた物のほかはどれもテストがある", () => {
    const run = spawnSync(process.execPath, [join(root, "scripts", "scenarios.ts"), "security", "auto-stop"], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /\| 記録が書き換わる \| apps\/office\/test\/gate\/audit-logs\.test\.ts \|/);
  });
});
