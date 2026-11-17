// 設計書から作る Issue の決まった形 (開発の回し方の 3.3、3.4)。ラベル、要件の読み、題と本文、送り直しの鍵、issue_plan の入力の上限
import { describe, expect, it } from "vitest";
import { checkServiceDocs, devIssueKey, devIssueText, featureTitle, ISSUE_LABELS, IssuePlanTool, isRedactedName, parseRequirements } from "../../src/index.ts";

const DETAIL = ["# 詳細設計 1. 動画", "", "## 1. 要件", "", "- **動画を作る**: 文章から作る", "- **動画を見る**: 一覧で見る", "", "## 2. 作る物", "", "- **ここは要件でない**: 2 章の項目"].join("\n");

const SERVICE = "01900000-0000-7000-8000-000000000001";

/**
 * 子 n 件を持つ親 1 件の入力を作る
 * @param n 子の数
 * @returns issue_plan の入力
 */
function plan(n: number): unknown {
  return { serviceId: SERVICE, parents: [{ feature: "1-video", children: Array.from({ length: n }, (_, i) => ({ requirement: `要件 ${String(i)}`, kind: "feature", paths: ["src/a.ts"] })) }] };
}

/**
 * 子 1 件の paths だけを変えた入力を作る
 * @param paths 触るファイルの glob
 * @returns issue_plan の入力
 */
function withPaths(paths: unknown): unknown {
  return { serviceId: SERVICE, parents: [{ feature: "1-video", children: [{ requirement: "動画を作る", kind: "chore", paths }] }] };
}

/**
 * 子 1 件の入力を作る。extra で項目を足す
 * @param extra 足す項目
 * @returns issue_plan の入力
 */
function child(extra: Record<string, unknown>): unknown {
  return { serviceId: SERVICE, parents: [{ feature: "1-video", children: [{ requirement: "a", kind: "feature", paths: ["a"], ...extra }] }] };
}

/**
 * 親 n 件、それぞれ子 each 件の入力を作る
 * @param n 親の数
 * @param each 親ごとの子の数
 * @returns issue_plan の入力
 */
function parents(n: number, each: number): unknown {
  return { serviceId: SERVICE, parents: Array.from({ length: n }, (_, i) => ({ feature: `${String(i + 1)}-f`, children: Array.from({ length: each }, () => ({ requirement: "a", kind: "chore", paths: ["a"] })) })) };
}

/**
 * 触るファイルの glob を count 個並べる
 * @param count 個数
 * @returns glob
 */
function pathsOfCount(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/${String(i)}.ts`);
}

/**
 * 機能の名前だけを変えた入力を作る
 * @param name 機能の名前
 * @returns issue_plan の入力
 */
function featureOf(name: string): unknown {
  return { serviceId: SERVICE, parents: [{ feature: name, children: [{ requirement: "a", kind: "chore", paths: ["a"] }] }] };
}

describe("設計書から Issue を作る", () => {
  it("親と子の Issue", async () => {
    // 1 章の要件だけを読み、2 章の項目は読まない。本文が同じならハッシュも同じで、変われば変わる
    const first = await parseRequirements(DETAIL);
    expect(first.map((r) => r.name)).toEqual(["動画を作る", "動画を見る"]);
    expect(first[0]?.hash).toMatch(/^[\da-f]{16}$/);
    const changed = await parseRequirements(DETAIL.replace("文章から作る", "台本から作る"));
    expect(changed[0]?.hash).not.toBe(first[0]?.hash);
    expect(changed[1]?.hash).toBe(first[1]?.hash);
    expect(featureTitle(DETAIL)).toBe("動画");
    expect(featureTitle("# 題だけ")).toBeNull();
    // 題は機能と要件の名前、本文は設計書の章の名前と済みの条件の 2 行だけ
    expect(devIssueText({ feature: "1-video", featureName: "動画", requirement: null })).toEqual({ title: "動画", body: "設計書: 詳細設計 1-video の機能「動画」\n済みの条件: 子 Issue がすべて閉じる" });
    expect(devIssueText({ feature: "1-video", featureName: "動画", requirement: "動画を作る" })).toEqual({
      title: "動画を作る",
      body: "設計書: 詳細設計 1-video の要件「動画を作る」\n済みの条件: テスト設計の同じ要件のシナリオが通り、main に入る",
    });
    // 送り直しの鍵は、サービス、種類、機能、要件、ハッシュのどれが違っても変わる
    const base = { serviceId: SERVICE, kind: "child", feature: "1-video", requirement: "動画を作る", hash: "a".repeat(16) } as const;
    const key = await devIssueKey(base);
    expect(key).toMatch(/^[\da-f]{64}$/);
    expect(await devIssueKey(base)).toBe(key);
    for (const other of [{ serviceId: "x" }, { kind: "parent" }, { feature: "2-x" }, { requirement: "別" }, { hash: "b".repeat(16) }] as const) {
      expect(await devIssueKey({ ...base, ...other })).not.toBe(key);
    }
  });

  it("決まっていないラベル", () => {
    expect(ISSUE_LABELS).toEqual(["bug", "feature", "chore", "priority: high", "blocked", "needs-owner"]);
    expect(IssuePlanTool.safeParse(plan(1)).success).toBe(true);
    // 種類は 3 つ、優先度は high だけ。ほかのラベルは入力の形で断る
    expect(IssuePlanTool.safeParse(child({ kind: "blocked" })).success).toBe(false);
    expect(IssuePlanTool.safeParse(child({ kind: "priority: high" })).success).toBe(false);
    expect(IssuePlanTool.safeParse(child({ priority: "urgent" })).success).toBe(false);
    expect(IssuePlanTool.safeParse(child({ labels: ["wontfix"] })).success).toBe(false);
    expect(IssuePlanTool.safeParse(child({ priority: "high" })).success).toBe(true);
  });

  it("1 回に 10 件まで", () => {
    expect(IssuePlanTool.safeParse(plan(10)).success).toBe(true);
    expect(IssuePlanTool.safeParse(plan(11)).success).toBe(false);
    // 子 0 件の親は、設計書から消えた機能の子を閉じるだけの指定。親そのものが 0 件の入力は断る
    expect(IssuePlanTool.safeParse(plan(0)).success).toBe(true);
    expect(IssuePlanTool.safeParse({ serviceId: SERVICE, parents: [] }).success).toBe(false);
    // 親は 10 まで。子の合計が 10 を超えても断る
    expect(IssuePlanTool.safeParse(parents(10, 1)).success).toBe(true);
    expect(IssuePlanTool.safeParse(parents(11, 1)).success).toBe(false);
    expect(IssuePlanTool.safeParse(parents(2, 6)).success).toBe(false);
    expect(IssuePlanTool.safeParse(parents(2, 5)).success).toBe(true);
  });

  it("触るファイルの glob は 1 から 20 個で、1 つ 200 字まで、.. と頭の / を断る", () => {
    const n = pathsOfCount;
    expect(IssuePlanTool.safeParse(withPaths(n(1))).success).toBe(true);
    expect(IssuePlanTool.safeParse(withPaths(n(20))).success).toBe(true);
    expect(IssuePlanTool.safeParse(withPaths(n(21))).success).toBe(false);
    expect(IssuePlanTool.safeParse(withPaths([])).success).toBe(false);
    expect(IssuePlanTool.safeParse(withPaths(["a".repeat(200)])).success).toBe(true);
    expect(IssuePlanTool.safeParse(withPaths(["a".repeat(201)])).success).toBe(false);
    expect(IssuePlanTool.safeParse(withPaths(["../secret"])).success).toBe(false);
    expect(IssuePlanTool.safeParse(withPaths(["src/../../x"])).success).toBe(false);
    expect(IssuePlanTool.safeParse(withPaths(["/etc/passwd"])).success).toBe(false);
    expect(IssuePlanTool.safeParse(withPaths(["src/..x/a.ts"])).success).toBe(true);
  });

  it("機能の名前は <番号>-<名前> の形だけ", () => {
    const feature = featureOf;
    expect(IssuePlanTool.safeParse(feature("1-video")).success).toBe(true);
    for (const bad of ["video", "1-Video", "../1-x", "1-x/../y", "1_x"]) expect(IssuePlanTool.safeParse(feature(bad)).success).toBe(false);
  });

  it("伏せる形の名前は要件にできない。設計書の確かめも同じ判断を使う", () => {
    expect(isRedactedName("動画を作る")).toBe(false);
    expect(isRedactedName("鍵 sk-abcdef を作る")).toBe(true);
    expect(isRedactedName("a@example.com に送る")).toBe(true);
    const readme = ["---", "name: demo", "summary: 小さな物", "repo: example/demo", "kind: tool", "status: planning", "visibility: private", "---", "", "# demo"].join("\n");
    const files = (detail: string) => new Map([["README.md", readme], ["docs/04-detail/1-video.md", detail]]);
    expect(checkServiceDocs("demo", files(DETAIL))).toEqual([]);
    const problems = checkServiceDocs("demo", files(DETAIL.replace("動画を作る", "鍵 sk-abcdef を作る")));
    expect(problems.map((p) => p.path)).toEqual(["docs/04-detail/1-video.md"]);
  });
});
