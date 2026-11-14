// lint-edited.ts の、フックの入力から lint するファイルを選ぶ所を確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { lintReport, lintTarget } from "./lint-edited.ts";

const ROOT = "/repo/know-office";

void describe("書いたファイルだけをすぐ lint する", () => {
  void it("リポジトリの中の ts と tsx はリポジトリからの相対パスを返す", () => {
    assert.equal(lintTarget({ tool_input: { file_path: `${ROOT}/apps/office/src/gate/index.ts` } }, ROOT), "apps/office/src/gate/index.ts");
    assert.equal(lintTarget({ tool_input: { file_path: `${ROOT}/apps/office/src/screen/App.tsx` } }, ROOT), "apps/office/src/screen/App.tsx");
  });

  void it("ts でないファイルとリポジトリの外のファイルは選ばない", () => {
    assert.equal(lintTarget({ tool_input: { file_path: `${ROOT}/README.md` } }, ROOT), undefined);
    assert.equal(lintTarget({ tool_input: { file_path: "/repo/knowidea/tools/x.ts" } }, ROOT), undefined);
    assert.equal(lintTarget({ tool_input: { file_path: `${ROOT}/node_modules/a/index.ts` } }, ROOT), undefined);
  });

  void it("形の違う入力は選ばない", () => {
    assert.equal(lintTarget({}, ROOT), undefined);
    assert.equal(lintTarget("x", ROOT), undefined);
    assert.equal(lintTarget({ tool_input: { file_path: 1 } }, ROOT), undefined);
  });
});

void describe("lint の結果をフックの返事にする", () => {
  void it("通った時は 0 で何も返さない", () => {
    assert.deepEqual(lintReport({ status: 0, stdout: "ok", stderr: "" }), { code: 0, message: "" });
  });

  void it("落ちた時は 2 で出力の最後の 40 行を返す", () => {
    const stdout = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const report = lintReport({ status: 1, stdout, stderr: "" });
    assert.equal(report.code, 2);
    assert.equal(report.message.split("\n").length, 40);
    assert.equal(report.message.split("\n")[0], "line 60");
  });

  void it("oxlint を走らせられない時は 2 でそう返す", () => {
    const report = lintReport({ status: null, stdout: "", stderr: "", error: new Error("spawn pnpm ENOENT") });
    assert.equal(report.code, 2);
    assert.match(report.message, /oxlint を走らせられない: spawn pnpm ENOENT/);
  });
});

void describe("リポジトリの中の .. で始まる名前", () => {
  void it("..で始まるファイル名はリポジトリの中とみなす", () => {
    assert.equal(lintTarget({ tool_input: { file_path: `${ROOT}/..odd.ts` } }, ROOT), "..odd.ts");
  });
});
