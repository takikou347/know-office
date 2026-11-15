// know-office 自身のリポジトリで、ルールの判断、自動停止、鍵を扱うファイルを変える PR は、レビュー担当の承認に加えてオーナーの承認を待つ (タスクとレビューの 3.7、要件 services の know-office 自身を管理する)
import type { StaffId } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { services } from "../../src/gate/db/main.ts";
import { createNode } from "../../src/gate/work/nodes.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { api, clockIn, purposeAndGoal, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

/** マイグレーションで 2 番目に登録した know-office 自身のサービス */
const SELF_SERVICE = "00000000-0000-7000-8000-000000000102";
/** テストで know-office 自身とみるリポジトリ。公開のリポジトリの名前に人の名前を残さない */
const OFFICE = "example/know-office";
/** know-office 自身でないリポジトリ */
const UI = "example/knowidea-ui";
const SHA = { base: "a".repeat(40), head: "b".repeat(40) };

// マイグレーションの 2 つのサービスは代わりの GitHub に無いリポジトリを指すので、テストのリポジトリに向け直す
beforeEach(async () => {
  const orm = drizzle(world.d1.DB);
  await orm.update(services).set({ repo: OFFICE }).where(eq(services.id, SELF_SERVICE));
  await orm.update(services).set({ repo: UI }).where(eq(services.name, "knowidea-ui"));
});

/**
 * 代わりの GitHub にリポジトリを置く。プルリクエスト、チェック、main を進める返事と、compare が返す変えたファイルを決める
 * @param w テストの物
 * @param repo リポジトリ
 * @param files compare が返すファイル
 */
function repoOnGitHub(w: WorkWorld, repo: string, files: { filename: string; previous_filename?: string }[]): void {
  const gh = w.gate.github;
  gh.set(`POST /repos/${repo}/pulls`, { number: 1, base: { sha: SHA.base }, head: { sha: SHA.head } });
  gh.set(`GET /repos/${repo}/pulls/1`, { number: 1, base: { sha: SHA.base }, head: { sha: SHA.head } });
  gh.set(`GET /repos/${repo}/commits/${SHA.head}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  gh.set(`PATCH /repos/${repo}/git/refs/heads/main`, { ref: "refs/heads/main", object: { sha: SHA.head } });
  w.gate.github.files = files;
}

/**
 * 社員のツールを、代わりの GitHub につないだ口で呼ぶ
 * @param w テストの物
 * @param staffId 呼ぶ社員
 * @param name ツールの名前
 * @param input 入力
 * @returns ツールの答え
 */
function tool(w: WorkWorld, staffId: StaffId, name: string, input: unknown) {
  return runTool(w.gate.env, w.gate.forge, { staffId, tool: name, input, now: w.clock.now(), guard: w.gate.deps });
}

/**
 * 開発担当がプルリクエストを出し、レビュー担当がレビューのタスクを取るところまで進める
 * @param w テストの物
 * @param repo 直すリポジトリ
 * @returns 開発担当のタスク ID
 */
async function openedPull(w: WorkWorld, repo: string): Promise<string> {
  const { goal } = await purposeAndGoal(w);
  await clockIn(w, "builder", "reviewer");
  const project = (await createNode(w.gate.env, { kind: "project", parentId: goal, scope: "office", title: "自動停止" }, { by: "owner", now: w.clock.now() })).id;
  const task = (await createNode(w.gate.env, { kind: "task", parentId: project, scope: "office", title: "自動停止の数え方を直す", taskKind: "fix", assignee: "builder", repo }, { by: "owner", now: w.clock.now() })).id;
  await staffOf(w, "builder").pull(w.clock.now());
  expect(await tool(w, "builder", "pr_open", { name: "guard-count", title: "自動停止の数え方を直す", body: "" })).toMatchObject({ isError: false });
  await staffOf(w, "reviewer").pull(w.clock.now());
  return task;
}

/**
 * main を進めた要求の本文
 * @param w テストの物
 * @param repo リポジトリ
 * @returns 本文
 */
function mainMoves(w: WorkWorld, repo: string): unknown[] {
  return w.gate.github.requests.filter((r) => r.route === `PATCH /repos/${repo}/git/refs/heads/main`).map((r) => r.body);
}

/**
 * タスクの出来事の種類と中身を読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns 出来事
 */
async function events(w: WorkWorld, nodeId: string): Promise<{ kind: string; detail: unknown }[]> {
  const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.unknown() }).loose()) }).loose().parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  return detail.events.map((e) => ({ kind: e.kind, detail: e.detail }));
}

/**
 * レビュー担当が承認する
 * @param w テストの物
 * @returns main に入れたか
 */
async function reviewerApproves(w: WorkWorld): Promise<boolean> {
  const answer = await tool(w, "reviewer", "review_submit", { verdict: "approve", summary: "数え方とテストを確かめた。未確認の所は無い" });
  return z.object({ merged: z.boolean() }).parse(JSON.parse(answer.content)).merged;
}

describe("know-office 自身を管理する", () => {
  it("セキュリティの部分を直す", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/guard/observe.ts" }, { filename: "apps/office/test/guard/observe.test.ts" }]);
    const task = await openedPull(world, OFFICE);

    // レビュー担当の承認だけでは入らない
    expect(await reviewerApproves(world)).toBe(false);
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    expect((await events(world, task)).find((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });

    // オーナーの承認がそろうと入る
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "自動停止の直しを確かめた", baseSha: SHA.head });
    expect(mainMoves(world, OFFICE)).toEqual([{ sha: SHA.head, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });
});

describe("守りのファイルの決まり", () => {
  for (const path of ["packages/core/src/rules/decide.ts", "packages/core/src/guard/signals.ts", "apps/office/src/gate/guard/thresholds.ts", "apps/office/src/gate/auth/vault.ts", "packages/core/src/keys.ts", "apps/office/src/gate/do/guard.ts", "apps/office/src/gate/auth/guard-book.ts"]) {
    it(`${path} を変える PR はオーナーの承認を待つ`, async () => {
      repoOnGitHub(world, OFFICE, [{ filename: path }]);
      await openedPull(world, OFFICE);
      expect(await reviewerApproves(world)).toBe(false);
      expect(mainMoves(world, OFFICE)).toEqual([]);
    });
  }

  it("守りのファイルから動かしただけの PR もオーナーの承認を待つ", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/old-guard.ts", previous_filename: "apps/office/src/gate/guard/actions.ts" }]);
    await openedPull(world, OFFICE);
    expect(await reviewerApproves(world)).toBe(false);
    expect(mainMoves(world, OFFICE)).toEqual([]);
  });

  it("know-office 自身の守りでないファイルは、レビュー担当の承認で入る", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/work/loop.ts" }, { filename: "apps/office/src/gate/guard.md" }, { filename: "packages/core/src/rules.md" }]);
    const task = await openedPull(world, OFFICE);
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world, OFFICE)).toEqual([{ sha: SHA.head, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("ほかのサービスのリポジトリの同じ道は、レビュー担当の承認で入る", async () => {
    repoOnGitHub(world, UI, [{ filename: "apps/office/src/gate/guard/observe.ts" }]);
    await openedPull(world, UI);
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world, UI)).toEqual([{ sha: SHA.head, force: false }]);
  });

  it("オーナーが先に承認していても、レビュー担当の承認が出るまで入れない", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/guard/observe.ts" }]);
    const task = await openedPull(world, OFFICE);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: SHA.head });
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world, OFFICE)).toEqual([{ sha: SHA.head, force: false }]);
  });
});
