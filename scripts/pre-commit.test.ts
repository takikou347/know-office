// pre-commit.ts の、コミットの前に作者と足した行を確かめる所を確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { addedEmails, identProblem } from "./pre-commit.ts";

void describe("コミットの前に、作者とメールアドレスを確かめる", () => {
  void it("作者と入れた者が KNOW IDEA の時だけ通す", () => {
    assert.equal(identProblem("KNOW IDEA <noreply@knowidea.invalid> 1731600000 +0900"), undefined);
    assert.match(identProblem("Someone <someone@mail.test> 1731600000 +0900") ?? "", /KNOW IDEA/);
    // 名前が同じでもメールアドレスが違えば断る
    assert.match(identProblem("KNOW IDEA <other@knowidea.invalid> 1731600000 +0900") ?? "", /KNOW IDEA/);
  });

  void it("足した行のメールアドレスのうち、noreply と例の物でない物を返す", () => {
    // 通さないメールアドレスをこのファイルに書くと、このフックが断るので、走らせる時に組み立てる
    const owner = ["owner", "mail.jp"].join("@");
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      '+const a = "noreply@knowidea.invalid";',
      `+const b = "${owner}"; const g = "a@mail.test";`,
      '-const c = "removed@mail.test";',
      ' const d = "kept@mail.test";',
      '+const e = "user@example.com"; const f = "1+bot[bot]@users.noreply.github.com";',
    ].join("\n");
    assert.deepEqual(addedEmails(diff), [owner]);
  });

  void it("パッケージの版と、diff の印の + はメールアドレスとして数えない", () => {
    const diff = ['+"packageManager": "pnpm@10.28.0",', "+      zod: 4.6.7(zod@4.6.7)(react@19.3.1)", "+noreply@knowidea.invalid が作者"].join("\n");
    assert.deepEqual(addedEmails(diff), []);
  });

  void it("noreply でも、CI と同じドメインの物だけを通し、大文字小文字は区別しない", () => {
    const other = ["noreply", "mail.jp"].join("@");
    assert.deepEqual(addedEmails(`+${other}\n+NoReply@KnowIdea.Invalid\n+User@Example.COM`), [other]);
  });

  void it("ファイルの名前の行はメールアドレスとして数えない", () => {
    assert.deepEqual(addedEmails(`+++ b/docs/${["someone", "mail.jp"].join("@")}.md\n+text`), []);
  });
});
