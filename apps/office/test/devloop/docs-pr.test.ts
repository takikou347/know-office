// 設計書の PR の道の確かめ (verifyDocsPr) を、GitHub を読まずに直に呼んで確かめる (開発の回し方の 3.2)
import { describe, expect, it } from "vitest";
import { verifyDocsPr } from "../../src/gate/devloop/docs-pr.ts";
import { DOCS, link } from "../helpers/docs.ts";
import { appForge } from "../helpers/review.ts";
import { useWork } from "../helpers/work.ts";

const world = useWork({ github: true });
const ONE = "設計書の PR は 1 つの services/<名前>/ の下だけを変える";
const SHA = "a".repeat(40);

// 道の確かめで断る入力は、木も中身も読まずに返す。木が切られていれば待ち (waiting) になり、断らなかった事が分かる
function verify(paths: string[], expected?: string): ReturnType<typeof verifyDocsPr> {
  world.gate.github.set(`GET /repos/${DOCS}/git/trees/${SHA}`, { sha: SHA, tree: [], truncated: true });
  return verifyDocsPr(appForge(world), DOCS, SHA, paths, expected);
}

describe("設計書の PR の変えた道", () => {
  it("名前の形が違う置き場は、名前の確かめで断る", async () => {
    for (const path of ["services/A_b/README.md", "services/.hidden/README.md", "services/a..b/README.md"]) {
      expect(await verify([path])).toMatchObject({ kind: "refused", reason: ONE });
    }
  });

  it("2 つのサービスにまたがる変更は、1 つだけの確かめで断る", async () => {
    expect(await verify(["services/a/README.md", "services/b/README.md"])).toMatchObject({ kind: "refused", reason: ONE });
  });

  it("タスクで期待する名前と違う置き場は断り、合えば先に進む", async () => {
    await link(world);
    const path = ["services/a/README.md"];
    expect(await verify(path, "b")).toMatchObject({ kind: "refused", errors: [{ pointer: "#/files" }] });
    expect(await verify(path, "a")).toMatchObject({ kind: "waiting" });
    expect(await verify(path)).toMatchObject({ kind: "waiting" });
  });
});
