// scenarios.ts の、詳細設計の要件のシナリオとテストの名前を突き合わせる所を確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { docPath, matchScenarios, readScenarios, testNames } from "./scenarios.ts";
import { knowideaDir } from "./verify.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 一時の置き場にファイルを並べる
 * @param files 置き場からの道と中身
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

const DOC = [
  "# 見本",
  "",
  "## 4. テスト",
  "",
  "### 4.1 要件とシナリオ",
  "",
  "| 要件 | 中身とシナリオ |",
  "| --- | --- |",
  "| 見本の要件 | 本文の **太字** は拾わない。<br>1. 並び<br>**見本の要求**: 証明が無い → 断る<br>**見本の人**: 人が違う → 断る \\| 403 |",
  "| 見本のチェック | 本文。<br>**見本の部品**: 部品が古い → 落ちる |",
  "",
  "### 4.2 テストの置き場",
  "",
  "| 要件のシナリオ | テストの置き場 |",
  "| --- | --- |",
  "| 別の章 | <br>**拾わない**: x |",
  "",
].join("\n");

void describe("要件のシナリオとテストを突き合わせる", () => {
  void it("詳細設計の要件とシナリオの章から、要件の名前とシナリオの名前を順に読む", () => {
    const dir = repo({ "6-guard.md": DOC });
    assert.deepEqual(readScenarios(join(dir, "6-guard.md")), [
      { doc: "6-guard", requirement: "見本の要件", scenario: "見本の要求" },
      { doc: "6-guard", requirement: "見本の要件", scenario: "見本の人" },
      { doc: "6-guard", requirement: "見本のチェック", scenario: "見本の部品" },
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

  void it("テストの無いシナリオを返す", () => {
    const scenarios = [
      { doc: "6-guard", requirement: "r", scenario: "a" },
      { doc: "6-guard", requirement: "r", scenario: "c" },
    ];
    const result = matchScenarios(scenarios, new Map([["a", ["x.test.ts"]]]));
    assert.deepEqual(result.rows.map((row) => [row.scenario, row.where]), [["a", "x.test.ts"], ["c", "無い"]]);
    assert.deepEqual(result.missing.map((row) => row.scenario), ["c"]);
  });

  void it("文書の名前から、04-detail.md か 04-detail/ の機能ごとの文書を指す", () => {
    assert.equal(docPath("/k", "04-detail"), "/k/services/know-office/docs/04-detail.md");
    assert.equal(docPath("/k", "6-guard"), "/k/services/know-office/docs/04-detail/6-guard.md");
  });

  void it("knowidea が無い時は突き合わせを飛ばす", () => {
    const run = spawnSync(process.execPath, [join(root, "scripts", "scenarios.ts"), "6-guard"], {
      encoding: "utf8",
      env: { ...process.env, KNOWIDEA_DIR: join(tmpdir(), "no-knowidea") },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /knowidea が .* に無いので飛ばす/);
  });

  void it("要件とシナリオの章の無い文書を渡すと落ちる", () => {
    const dir = repo({ "services/know-office/docs/04-detail/6-guard.md": "# 見本\n" });
    const run = spawnSync(process.execPath, [join(root, "scripts", "scenarios.ts"), "6-guard"], {
      encoding: "utf8",
      env: { ...process.env, KNOWIDEA_DIR: dir },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /6-guard に要件とシナリオが無い/);
  });

  const knowidea = knowideaDir(root, process.env);
  void it("自動停止 (6-guard) のシナリオはどれもテストがある", { skip: existsSync(knowidea) ? false : `knowidea が ${knowidea} に無い` }, () => {
    const run = spawnSync(process.execPath, [join(root, "scripts", "scenarios.ts"), "6-guard"], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /\| 6-guard: 止めるのはシステム \| タスク 1 つを止める \| apps\/office\/test\/guard\/stop\.test\.ts/);
  });
});
