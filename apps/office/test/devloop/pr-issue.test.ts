// 子 Issue のタスクの PR。本文にゲートウェイが Closes を付け、bug と feature はテストのファイルを変えていなければ断る。出し直しは新しい PR を出さない (開発の回し方の 3.5)
import type { ToolResult } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { docsAt, GOOD, HEAD, pullOnGitHub, tool as docsTool } from "../helpers/docs.ts";
import { child, planOf, plan, withDocs } from "../helpers/issues.ts";
import { z } from "zod";
import { clockIn, purposeAndGoal, REPO, rows, staffOf, tool, useWork } from "../helpers/work.ts";
import type { ChangedFile } from "../../src/gate/work/loop.ts";

const world = useWork({ github: true });

/**
 * 変えたファイルを返す代わりの compare にする
 * @param paths 変えたファイルの道。removed: を頭に付けた物は消した物
 * @param truncated GitHub が 300 件で切ったか
 * @returns 呼んだ回数を数える物
 */
function changes(paths: string[], truncated = false): { calls: string[][] } {
  const seen = { calls: [] as string[][] };
  world.forge.compare = (_repo, base, head) => {
    seen.calls.push([base, head]);
    const files: ChangedFile[] = paths.map((p) => ({ path: p.replace(/^removed:/, ""), status: p.startsWith("removed:") ? "removed" : "modified", patch: null }));
    return Promise.resolve({ files, truncated });
  };
  return seen;
}

/**
 * 子 1 件を送り、開発担当に取らせる
 * @param kind 子の種類
 * @returns Issue の番号
 */
async function working(kind: "bug" | "feature" | "chore"): Promise<number> {
  const id = await withDocs(world);
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await clockIn(world, "president", "builder", "reviewer");
  const made = await plan(world, planOf(id, [child("動画を作る", { kind })]));
  const number = made.children[0]?.number ?? 0;
  expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE source = ?", `issue:${String(number)}`)).toEqual([{ status: "doing" }]);
  return number;
}

/**
 * pr_open を呼ぶ
 * @param name ブランチの名前
 * @param body 本文
 * @returns ツールの答え
 */
function open(name = "make", body = "テストを足した"): Promise<ToolResult> {
  return tool(world, "builder", "pr_open", { name, title: "動画を作る", body });
}

/**
 * 失敗するはずの pr_open の答えを読む
 * @returns 投げた物の code と pointer の一覧
 */
async function refused(): Promise<{ code: string; pointers: string[] }> {
  const error = await open().then(
    () => null,
    (e: unknown) => e,
  );
  const found = (error ?? {}) as { code?: string; errors?: { pointer: string }[] };
  return { code: found.code ?? "none", pointers: (found.errors ?? []).map((e) => e.pointer) };
}

describe("1 Issue を 1 回の作業で入れる", () => {
  it("子 Issue から PR", async () => {
    const number = await working("feature");
    const seen = changes(["src/a.ts", "src/a.test.ts"]);
    expect(await open()).toMatchObject({ isError: false });
    // 本文の最後に、ゲートウェイが Closes を付ける
    expect(world.forge.bodies).toEqual([`テストを足した\n\nCloses #${String(number)}`]);
    expect(await rows(world.d1.DB, "SELECT status, pr_number FROM nodes WHERE source = ?", `issue:${String(number)}`)).toEqual([{ status: "review", pr_number: 1 }]);
    // 変えたファイルは固定した先で 1 回だけ読み、ルールの確かめとテストの確かめの両方に使う
    expect(seen.calls).toEqual([["main", "b".repeat(40)]]);
  });

  it("テストの無い PR", async () => {
    await working("feature");
    changes(["src/a.ts", "docs/a.md"]);
    expect(await refused()).toEqual({ code: "validation_failed", pointers: ["#/files"] });
    // GitHub に PR を出さず、タスクは作業中のまま
    expect(world.forge.pulls).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE status != 'dropped' AND source LIKE 'issue:%'")).toEqual([{ status: "doing" }]);
  });

  it("bug の PR も、テストのファイルが無ければ断る", async () => {
    await working("bug");
    changes(["src/a.ts"]);
    expect(await refused()).toEqual({ code: "validation_failed", pointers: ["#/files"] });
    expect(world.forge.pulls).toEqual([]);
  });

  it("テストの無い chore", async () => {
    await working("chore");
    changes(["src/a.ts"]);
    expect(await open()).toMatchObject({ isError: false });
    expect(world.forge.pulls).toHaveLength(1);
    // 設計書のリポジトリへの PR も、テストのファイルが無くても断らない
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo' WHERE title LIKE '設計書:%'").run();
    await staffOf(world, "builder").pull(world.clock.now());
    pullOnGitHub(world, Object.keys(GOOD));
    docsAt(world, HEAD, GOOD);
    expect(await docsTool(world, "builder", "pr_open", { name: "video-maker-docs", title: "設計書", body: "" })).toMatchObject({ isError: false });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE title LIKE '設計書:%'")).toEqual([{ status: "review" }]);
  });
});

describe("子 Issue の PR の確かめ", () => {
  it("消したテストのファイルは数えない", async () => {
    await working("feature");
    changes(["src/a.ts", "removed:src/a.test.ts"]);
    expect(await refused()).toEqual({ code: "validation_failed", pointers: ["#/files"] });
  });

  it("compare が 300 件で切れたら、bug と feature は断る", async () => {
    await working("bug");
    changes(["src/a.test.ts"], true);
    expect(await refused()).toEqual({ code: "validation_failed", pointers: ["#/files"] });
  });

  it("子を持たないタスクは確かめず、Closes も付けない", async () => {
    await clockIn(world, "president", "builder", "reviewer");
    const { goal } = await purposeAndGoal(world);
    const project = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "project", parentId: goal, title: "勤怠" })).content)).id;
    await tool(world, "president", "node_create", { kind: "task", parentId: project, title: "勤怠の表をつなぐ", taskKind: "build", repo: REPO, assignee: "builder" });
    await staffOf(world, "builder").pull(world.clock.now());
    changes([]);
    expect(await open()).toMatchObject({ isError: false });
    expect(world.forge.bodies).toEqual(["テストを足した"]);
  });

  it("出した後にテストの無いコミットになった PR は main に入れない", async () => {
    await working("feature");
    changes(["src/a.ts", "src/a.test.ts"]);
    await open();
    await clockIn(world, "reviewer");
    // レビューの後に、テストのファイルを消したコミットが先になった
    changes(["src/a.ts"]);
    expect(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "確かめた", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    expect(world.forge.merged).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE source LIKE 'issue:%'")).toEqual([{ status: "review" }]);
  });
});

describe("出し直し", () => {
  it("同じタスクの 2 度目の pr_open は新しい PR を出さない", async () => {
    const number = await working("feature");
    changes(["src/a.ts", "src/a.test.ts"]);
    await open("make");
    await clockIn(world, "reviewer");
    expect(await tool(world, "reviewer", "review_submit", { verdict: "reject", summary: "境目が無い", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    // 差し戻しで戻ったタスクを開発担当が取り直し、先を進めて出し直す。別の name でも新しい PR は出さない
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE source = ?", `issue:${String(number)}`)).toEqual([{ status: "doing" }]);
    world.forge.branchHead = () => Promise.resolve("c".repeat(40));
    expect(await open("other-name")).toMatchObject({ isError: false });
    expect(world.forge.pulls).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT status, pr_number, branch FROM nodes WHERE source = ?", `issue:${String(number)}`)).toMatchObject([{ status: "review", pr_number: 1 }]);
    // 先が変わったので承認を消し、レビューのタスクをもう 1 つ足して、レビュー担当に渡す
    expect(await rows(world.d1.DB, "SELECT head_sha, reviewer_verdict FROM reviews")).toEqual([{ head_sha: "c".repeat(40), reviewer_verdict: null }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE task_kind = 'review' ORDER BY rowid")).toEqual([{ status: "done" }, { status: "doing" }]);
  });
});
