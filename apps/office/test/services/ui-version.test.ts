// know-office が入れる knowidea-ui が、npm に出たバージョンだけを指す事を確かめる。足りないコンポーネントは knowidea-ui に足して出してから入れる (テスト設計のサービスと拡張)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/** know-office が入れる knowidea-ui の 4 つのパッケージ */
const UI_PACKAGES = ["knowidea-css", "knowidea-icons", "knowidea-tokens", "knowidea-ui"] as const;

/** npm の登録所が knowidea-ui の 4 つに返した、出したバージョンの一覧の記録。本物の npm は呼ばない。上げる時は出した後にここへ足す */
const PUBLISHED = ["0.11.0", "0.12.0", "0.12.1", "0.12.2", "0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0"] as const;

/** npm に出たバージョンの形。固定の x.y.z だけ */
const EXACT = /^\d+\.\d+\.\d+$/;

const PackageJson = z.object({ dependencies: z.record(z.string(), z.string()).optional() }).loose();

/**
 * know-office の knowidea-ui の入れ方を確かめ、問題を並べる
 * @param pkg apps/office/package.json の中身
 * @param lock pnpm-lock.yaml の中身
 * @param published npm に出たバージョンの一覧
 * @returns 問題の文の並び。無ければ空
 */
export function uiVersionProblems(pkg: string, lock: string, published: readonly string[]): string[] {
  const deps = PackageJson.parse(JSON.parse(pkg)).dependencies ?? {};
  const problems: string[] = [];
  const versions = new Set<string>();
  for (const name of UI_PACKAGES) {
    const spec = deps[name];
    if (spec === undefined) {
      problems.push(`${name} を入れていない`);
      continue;
    }
    // workspace:、link:、file:、git や範囲は npm に出たバージョンでない
    if (!EXACT.test(spec)) {
      problems.push(`${name} が npm に出たバージョンを指していない: ${spec}`);
      continue;
    }
    versions.add(spec);
    // 出した一覧に無い版は、最新より上か、出していない版
    if (!published.includes(spec)) problems.push(`${name}@${spec} は npm に出ていない`);
    // 手元の束や作りかけでなく、npm の登録所から取ったものだけが integrity を持つ
    const entry = new RegExp(`^ {2}${name}@${spec.replaceAll(".", "\\.")}:\\n {4}resolution: \\{integrity: sha512-`, "m");
    if (!entry.test(lock)) problems.push(`${name}@${spec} が npm の登録所から取られていない`);
  }
  if (versions.size > 1) problems.push(`4 つのバージョンがそろっていない: ${[...versions].join("、")}`);
  return problems;
}

const OFFICE = join(import.meta.dirname, "../..");

/**
 * 置いた npm の版で確かめる
 * @param p package.json の中身
 * @param l pnpm-lock.yaml の中身
 * @returns 問題の並び
 */
const check = (p: string, l: string) => uiVersionProblems(p, l, PUBLISHED);

/**
 * 4 つのパッケージの版を置いた package.json を作る
 * @param ui knowidea-ui の版
 * @param rest ほかの 3 つの版
 * @returns package.json の中身
 */
const pkg = (ui: string, rest = "0.12.1") => JSON.stringify({ dependencies: { "knowidea-css": rest, "knowidea-icons": rest, "knowidea-tokens": rest, "knowidea-ui": ui } });

describe("最初のサービスは knowidea-ui", () => {
  it("足りないコンポーネント", () => {
    const manifest = readFileSync(join(OFFICE, "package.json"), "utf8");
    const lock = readFileSync(join(OFFICE, "../../pnpm-lock.yaml"), "utf8");
    expect(uiVersionProblems(manifest, lock, PUBLISHED)).toEqual([]);
  });

  it("npm に出ていないバージョンを入れると問題になる", () => {
    const lock = "  knowidea-ui@0.12.1:\n    resolution: {integrity: sha512-abc}\n";
    expect(check(pkg("workspace:*"), lock)).toContain("knowidea-ui が npm に出たバージョンを指していない: workspace:*");
    expect(check(pkg("link:../../knowidea-ui/packages/ui"), lock)).toContain("knowidea-ui が npm に出たバージョンを指していない: link:../../knowidea-ui/packages/ui");
    expect(check(pkg("^0.12.1"), lock)).toContain("knowidea-ui が npm に出たバージョンを指していない: ^0.12.1");
    // 登録所から取っていない (tarball の道で入れた) 物は integrity の行が無い
    expect(check(pkg("0.13.0", "0.13.0"), "  knowidea-ui@0.13.0:\n    resolution: {tarball: file:release/knowidea-ui-0.13.0.tgz}\n")).toContain("knowidea-ui@0.13.0 が npm の登録所から取られていない");
    expect(check(pkg("0.12.1", "0.12.0"), lock)).toContain("4 つのバージョンがそろっていない: 0.12.0、0.12.1");
    expect(check(pkg("git+https://example.invalid/knowidea-ui.git"), lock)).toContain("knowidea-ui が npm に出たバージョンを指していない: git+https://example.invalid/knowidea-ui.git");
    expect(check(pkg("file:../release/knowidea-ui-0.12.1.tgz"), lock)).toContain("knowidea-ui が npm に出たバージョンを指していない: file:../release/knowidea-ui-0.12.1.tgz");
    // 最新より上の版は出ていない
    expect(check(pkg("0.99.0", "0.99.0"), "  knowidea-ui@0.99.0:\n    resolution: {integrity: sha512-abc}\n")).toContain("knowidea-ui@0.99.0 は npm に出ていない");
  });
});
