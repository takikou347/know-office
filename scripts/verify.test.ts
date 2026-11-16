// verify.ts の、手順を順に走らせて結果を短くまとめる所を確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { e2ePortFor, runSteps, stepsFor, summarize, type Step } from "./verify.ts";

void describe("push の前のチェックを短い出力で走らせる", () => {
  void it("通った手順は名前だけを 1 行で出す", () => {
    assert.equal(summarize({ name: "lint", code: 0, output: "長い出力\n".repeat(50) }), "ok   lint");
  });

  void it("かかった秒があれば名前の後に丸めて出す", () => {
    assert.equal(summarize({ name: "e2e", code: 0, output: "", seconds: 612.4 }), "ok   e2e (612s)");
    assert.equal(summarize({ name: "test", code: 1, output: "", seconds: 3.6 }), "FAIL test (4s) (exit 1)");
  });

  void it("落ちた手順は出力の最後の 40 行だけを出す", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const text = summarize({ name: "test", code: 1, output });
    const lines = text.split("\n");
    assert.equal(lines[0], "FAIL test (exit 1)");
    assert.equal(lines.length, 41);
    assert.equal(lines[1], "line 60");
    assert.equal(lines[40], "line 99");
  });

  void it("どの手順が落ちても最後まで走らせ、落ちた数を返す", () => {
    const ran: string[] = [];
    const exec = (step: Step) => {
      ran.push(step.name);
      return { code: step.name === "b" ? 2 : 0, output: "" };
    };
    const result = runSteps([{ name: "a" }, { name: "b" }, { name: "c" }], exec);
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.equal(result.failed, 1);
    assert.match(result.text, /ok   a\nFAIL b \(exit 2\)\nok   c/);
  });
});

void describe("走らせる手順を並べる", () => {
  void it("--e2e を付けた時だけ画面のテストを最後に足す", () => {
    const env = { KNOWIDEA_DIR: "/none" };
    assert.equal(stepsFor("/repo/know-office", [], env).some((step) => step.name === "e2e"), false);
    assert.equal(stepsFor("/repo/know-office", ["--e2e"], env).at(-1)?.name, "e2e");
  });

  void it("2-routes.md が v1.yaml と合うかを knowidea の道具で比べる", () => {
    const step = stepsFor("/repo/know-office", [], { KNOWIDEA_DIR: "/repo/knowidea" }).find((s) => s.name === "routes");
    assert.equal(step?.cmd, 'python3 "/repo/knowidea/tools/routes_md.py" --check "/repo/know-office/apps/office/openapi/v1.yaml"');
  });

  void it("knowidea が無い時は check.py の手順が落ちて置き場の渡し方を出す", () => {
    const step = stepsFor("/repo/know-office", [], { KNOWIDEA_DIR: "/none" }).find((s) => s.name === "check.py");
    assert.match(step?.cmd ?? "", /\/none に無い。KNOWIDEA_DIR で置き場を渡す" && exit 1$/);
  });

  void it("e2e は作業ツリーごとに違う入口の番号で走らせ、錠で待たない", () => {
    const one = stepsFor("/repo/a/know-office", ["--e2e"], { KNOWIDEA_DIR: "/none" });
    assert.equal(one.some((step) => step.cmd.includes("flock")), false);
    assert.equal(one.at(-1)?.cmd, `E2E_PORT=${e2ePortFor("/repo/a/know-office")} pnpm e2e`);
    assert.notEqual(e2ePortFor("/repo/a/know-office"), e2ePortFor("/repo/b/know-office"));
  });

  void it("入口の番号は 5200 から 5798 の偶数で、代わりの物の次の番号と重ならない", () => {
    for (const root of ["/", "/home/claude/know-office", "/home/claude/know-office/.claude/worktrees/x"]) {
      const port = e2ePortFor(root);
      assert.equal(port % 2, 0);
      assert.ok(port >= 5200 && port <= 5798);
    }
  });
});
