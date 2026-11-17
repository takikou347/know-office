// 触るファイルの glob の固定の頭と重なり、テストのファイルの判定 (開発の回し方の 3.5)
import { describe, expect, it } from "vitest";
import { globHead, globsOverlap, hasTestFile } from "../../src/index.ts";

describe("1 Issue を 1 回の作業で入れる", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["src/**/*.ts", "src/"],
    ["**/*.ts", ""],
    ["src/a?.ts", "src/a"],
    ["src/[ab].ts", "src/"],
    ["src/{a,b}.ts", "src/"],
    ["./src/a.ts", "src/a.ts"],
    ["././src/*.ts", "src/"],
    ["!src/a.ts", ""],
    ["\\*.ts", ""],
    ["*", ""],
    ["", ""],
  ])("globHead(%s) は %s", (glob, head) => {
    expect(globHead(glob)).toBe(head);
  });

  it.each([
    [["src/a/**"], ["src/a/b/*.ts"], true],
    [["src/a/*"], ["src/b/*"], false],
    [["src/a.ts"], ["src/a.tsx"], true],
    [["src/a/x.ts"], ["src/a/y.ts"], false],
    [["**/*.ts"], ["docs/x.md"], true],
    [["docs/x.md"], ["!src/a.ts"], true],
    [["src/a/x.ts", "docs/*"], ["lib/*", "docs/b.md"], true],
    [["src/*"], ["lib/*"], false],
  ])("globsOverlap(%j, %j) は %s", (a, b, overlap) => {
    expect(globsOverlap(a, b)).toBe(overlap);
  });

  it.each([
    [["src/a.ts", "src/a.test.ts"], true],
    [["e2e/flows/x.spec.tsx"], true],
    [["src/latest.ts", "src/spec.ts", "src/a.test"], false],
    [["test/helpers/x.ts"], false],
    [[], false],
  ])("hasTestFile(%j) は %s", (paths, found) => {
    expect(hasTestFile(paths)).toBe(found);
  });
});
