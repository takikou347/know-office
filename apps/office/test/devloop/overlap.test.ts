// 開発担当がタスクを取る時の重なりの確かめ。同じリポジトリの doing か review の子と、触るファイルの glob の固定の頭が重なる物は取らない (開発の回し方の 3.5)
import { describe, expect, it } from "vitest";
import { child, planOf, plan, withDocs } from "../helpers/issues.ts";
import { advance, api, at, clockIn, REPO, rows, staffOf, tool, useWork } from "../helpers/work.ts";
import { claimNode } from "../../src/gate/work/loop.ts";
import { findNode } from "../../src/gate/work/nodes.ts";

const world = useWork({ github: true });

const NAMES = ["動画を作る", "動画を見る", "動画を消す"] as const;

/**
 * 要件 3 つの設計書を置き、子を送って、開発担当に出勤させる。最初の子 (動画を作る) は優先度 high で、先に取られる
 * @param globs 子ごとの触るファイルの glob
 * @returns タスク ID を要件の名前で引く表
 */
async function setup(globs: [string[], string[], string[]]): Promise<Record<string, string>> {
  const text = ["# 詳細設計 1. 動画", "", "## 1. 要件", "", ...NAMES.map((n) => `- **${n}**: 本文`), ""].join("\n");
  const id = await withDocs(world, { "1-video.md": text });
  // 試作に進めた時の、設計書を書くタスクは見送り、開発担当が取るのを子のタスクだけにする
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await clockIn(world, "president", "builder", "reviewer");
  const children = NAMES.map((n, i) => child(n, { kind: "chore", paths: globs[i], ...(i === 0 ? { priority: "high" } : {}) }));
  await plan(world, planOf(id, children));
  const found = await rows(world.d1.DB, "SELECT id, title FROM nodes WHERE source LIKE 'issue:%'");
  return Object.fromEntries(found.map((r) => [String(r["title"]).replace(/^#\d+ /, ""), String(r["id"])]));
}

/** @returns 開発担当のタスクの状態を、要件の名前で引く表 */
async function states(): Promise<Record<string, string>> {
  const found = await rows(world.d1.DB, "SELECT title, status FROM nodes WHERE source LIKE 'issue:%'");
  return Object.fromEntries(found.map((r) => [String(r["title"]).replace(/^#\d+ /, ""), String(r["status"])]));
}

/**
 * 開発担当が今のタスクで PR を出す
 * @param name PR の題
 */
async function openPr(name: string): Promise<void> {
  expect(await tool(world, "builder", "pr_open", { title: name, body: "" })).toMatchObject({ isError: false });
}

describe("1 Issue を 1 回の作業で入れる", () => {
  it("触るファイルが重なる", async () => {
    await setup([["src/video/**"], ["src/video/view/*.ts"], ["docs/*.md"]]);
    // 先に取った子が review の間も、重なる子は飛ばして、重ならない次を取る
    expect(await states()).toEqual({ 動画を作る: "doing", 動画を見る: "todo", 動画を消す: "todo" });
    await openPr("make");
    expect(await states()).toEqual({ 動画を作る: "review", 動画を見る: "todo", 動画を消す: "doing" });
    // 取った子が review に出ても、待っていた重なる子は、重なっていた子が入るまで取らない
    // 山には重なる子だけが残る。空とは言わず、社長に次のタスクを求めない
    await world.d1.DB.prepare("UPDATE nodes SET status = 'done' WHERE source LIKE 'ask_boss:%'").run();
    await openPr("remove");
    expect(await states()).toEqual({ 動画を作る: "review", 動画を見る: "todo", 動画を消す: "review" });
    expect(await rows(world.d1.DB, "SELECT 1 FROM nodes WHERE source LIKE 'ask_boss:%' AND status != 'done'")).toEqual([]);
    // 重なっていた子が main に入ると、待っていた子を取る
    await advance(world, at(10));
    await staffOf(world, "reviewer").pull(world.clock.now());
    expect(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "確かめた", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    expect(await states()).toEqual({ 動画を作る: "done", 動画を見る: "doing", 動画を消す: "review" });
  });

  it("重なっていた子が見送られると、待っていた子を取る", async () => {
    const ids = await setup([["src/video/**"], ["src/video/view/*.ts"], ["docs/*.md"]]);
    await openPr("make");
    await openPr("remove");
    expect(await states()).toEqual({ 動画を作る: "review", 動画を見る: "todo", 動画を消す: "review" });
    // オーナーが review の子を見送りにすると、重なって待っていた子を取る
    const first = ids["動画を作る"] ?? "";
    const { version } = await findNode(world.d1.DB, first);
    await api(world, "PATCH", `/api/v1/nodes/${first}`, { version, status: "dropped" });
    expect(await states()).toEqual({ 動画を作る: "dropped", 動画を見る: "doing", 動画を消す: "review" });
  });

  it("頭の無い glob", async () => {
    await setup([["**/*.ts"], ["src/a.ts"], ["docs/*.md"]]);
    // 頭が空の子が doing の間は、ほかの子を取らない
    expect(await states()).toEqual({ 動画を作る: "doing", 動画を見る: "todo", 動画を消す: "todo" });
    await openPr("make");
    expect(await states()).toEqual({ 動画を作る: "review", 動画を見る: "todo", 動画を消す: "todo" });
  });
});

describe("取る文の重なりの確かめ", () => {
  it("同時に取りに来ても重なる 2 つは 1 つだけ doing になる", async () => {
    const ids = await setup([["src/video/**"], ["src/video/view/*.ts"], ["docs/*.md"]]);
    // 取った子を戻し、重なる 2 つが同じ版を読んで同時に取りに来る
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo' WHERE source LIKE 'issue:%'").run();
    const a = await findNode(world.d1.DB, ids["動画を作る"] ?? "");
    const b = await findNode(world.d1.DB, ids["動画を見る"] ?? "");
    const got = await Promise.all([claimNode(world.gate.env, a, world.clock.now()), claimNode(world.gate.env, b, world.clock.now())]);
    expect(got.filter((r) => r !== null)).toHaveLength(1);
    expect(Object.values(await states()).filter((s) => s === "doing")).toHaveLength(1);
  });

  it("別のサービスの同じ番号の子とは比べない", async () => {
    const ids = await setup([["src/video/**"], ["src/video/view/*.ts"], ["docs/*.md"]]);
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo' WHERE source LIKE 'issue:%'").run();
    // 重なる相手が review でも、別のリポジトリの行なら比べない
    await world.d1.DB.prepare("UPDATE nodes SET status = 'review', repo = 'other/repo' WHERE id = ?").bind(ids["動画を作る"]).run();
    const b = await findNode(world.d1.DB, ids["動画を見る"] ?? "");
    expect(await claimNode(world.gate.env, b, world.clock.now())).not.toBeNull();
  });

  it("dev_issues の無いタスクとレビューのタスクとは比べない", async () => {
    const ids = await setup([["**/*.ts"], ["src/a.ts"], ["docs/*.md"]]);
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo' WHERE source LIKE 'issue:%'").run();
    // 頭が空の子の相手が、子を持たない doing のタスクでも、取れる
    await world.d1.DB.prepare("INSERT INTO nodes (id, kind, scope, title, status, priority, repo, created_by, created_at, updated_at, source) VALUES ('x1', 'task', 'office', 'ほかのタスク', 'doing', 3, ?, 'system', 0, 0, 'other')").bind(REPO).run();
    const a = await findNode(world.d1.DB, ids["動画を作る"] ?? "");
    expect(await claimNode(world.gate.env, a, world.clock.now())).not.toBeNull();
  });

  it("heads の無い行はすべてと重なる", async () => {
    const ids = await setup([["src/a.ts"], ["src/b.ts"], ["docs/*.md"]]);
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo' WHERE source LIKE 'issue:%'").run();
    await world.d1.DB.prepare("UPDATE nodes SET status = 'review' WHERE id = ?").bind(ids["動画を作る"]).run();
    await world.d1.DB.prepare("UPDATE dev_issues SET heads = NULL").run();
    const b = await findNode(world.d1.DB, ids["動画を見る"] ?? "");
    expect(await claimNode(world.gate.env, b, world.clock.now())).toBeNull();
  });
});
