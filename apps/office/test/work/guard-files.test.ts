// know-office 自身のリポジトリで、ルールの判断、自動停止、鍵を扱うファイルを変える PR は、レビュー担当の承認に加えてオーナーの承認を待つ (タスクとレビューの 3.7、要件 services の know-office 自身を管理する)
import type { StaffId } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { services } from "../../src/gate/db/main.ts";
import { createNode } from "../../src/gate/work/nodes.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { type Connected, connect, hook, wrapDb } from "../helpers/github.ts";
import { appForge } from "../helpers/review.ts";
import { api, clockIn, purposeAndGoal, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/** マイグレーションで 2 番目に登録した know-office 自身のサービス */
const SELF_SERVICE = "00000000-0000-7000-8000-000000000102";
/** テストで know-office 自身とみるリポジトリ。公開のリポジトリの名前に人の名前を残さない */
const OFFICE = "example/know-office";
/** know-office 自身でないリポジトリ */
const UI = "example/knowidea-ui";
const SHA = { base: "a".repeat(40), head: "b".repeat(40), next: "c".repeat(40) };

/** 連携した App。通知を送る時に使う */
let linked: Connected;

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
  for (const sha of [SHA.head, SHA.next]) gh.set(`GET /repos/${repo}/commits/${sha}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  gh.set(`PATCH /repos/${repo}/git/refs/heads/main`, { ref: "refs/heads/main", object: { sha: SHA.head } });
  w.gate.github.files = files;
}

/**
 * GitHub からプルリクエストの先が進んだ通知 (synchronize) を送る
 * @param w テストの物
 * @param repo リポジトリ
 * @param sha 新しい先
 */
async function synchronize(w: WorkWorld, repo: string, sha: string): Promise<void> {
  const payload = { action: "synchronize", pull_request: { number: 1, head: { sha } }, repository: { full_name: repo }, installation: { id: linked.installationId } };
  expect((await hook(w, { event: "pull_request", payload, secret: linked.webhookSecret })).status).toBe(204);
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
  return runTool(w.gate.env, appForge(w), { staffId, tool: name, input, now: w.clock.now(), guard: w.gate.deps });
}

/**
 * 開発担当がプルリクエストを出し、レビュー担当がレビューのタスクを取るところまで進める
 * @param w テストの物
 * @param repo 直すリポジトリ
 * @returns 開発担当のタスク ID
 */
async function openedPull(w: WorkWorld, repo: string): Promise<string> {
  linked = await connect(w);
  const { goal } = await purposeAndGoal(w);
  await clockIn(w, "builder", "reviewer");
  const project = (await createNode(w.gate.env, { kind: "project", parentId: goal, scope: "office", title: "自動停止" }, { by: "owner", now: w.clock.now() })).id;
  const task = (await createNode(w.gate.env, { kind: "task", parentId: project, scope: "office", title: "自動停止の数え方を直す", taskKind: "fix", assignee: "builder", repo }, { by: "owner", now: w.clock.now() })).id;
  await staffOf(w, "builder").pull(w.clock.now());
  expect(await tool(w, "builder", "pr_open", { title: "自動停止の数え方を直す", body: "" })).toMatchObject({ isError: false });
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
 * @param headSha レビュー担当が読んだ先
 * @returns main に入れたか
 */
async function reviewerApproves(w: WorkWorld, headSha = SHA.head): Promise<boolean> {
  const answer = await tool(w, "reviewer", "review_submit", { verdict: "approve", summary: "数え方とテストを確かめた。未確認の所は無い", headSha });
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

  it("オーナーが承認した後に先が進んだら、守りのファイルの PR はもう一度オーナーの承認を待つ", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/guard/observe.ts" }]);
    const task = await openedPull(world, OFFICE);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: SHA.head });
    await synchronize(world, OFFICE, SHA.next);
    expect(await rows(world.d1.DB, "SELECT head_sha, owner_verdict, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: SHA.next, owner_verdict: null, reviewer_verdict: null }]);

    expect(await reviewerApproves(world, SHA.next)).toBe(false);
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect((await events(world, task)).findLast((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "進んだ先も確かめた", baseSha: SHA.next });
    expect(mainMoves(world, OFFICE)).toEqual([{ sha: SHA.next, force: false }]);
  });

  it("レビュー担当が承認した後に先が進んだら、オーナーの承認だけでは入れない", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/guard/observe.ts" }]);
    const task = await openedPull(world, OFFICE);
    expect(await reviewerApproves(world)).toBe(false);
    await synchronize(world, OFFICE, SHA.next);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: SHA.next });
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect((await events(world, task)).findLast((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "reviewer" } });
  });

  it("同じ先の synchronize がもう一度届いても、承認は消さない", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/guard/observe.ts" }]);
    const task = await openedPull(world, OFFICE);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: SHA.head });
    await synchronize(world, OFFICE, SHA.head);
    expect(await rows(world.d1.DB, "SELECT owner_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ owner_verdict: "approve" }]);
    expect(await reviewerApproves(world)).toBe(true);
  });

  it("レビュー担当が古い先で承認すると 409 で断り、承認も GitHub に写す行も書かない", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/work/loop.ts" }]);
    const task = await openedPull(world, OFFICE);
    await synchronize(world, OFFICE, SHA.next);
    await expect(reviewerApproves(world, SHA.head)).rejects.toMatchObject({ code: "conflict" });
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ reviewer_verdict: null }]);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM github_mirrors")).toEqual([{ n: 0 }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
  });

  it("レビュー担当が読んだ後、書く前に先が進んだら 409 で断り、承認も GitHub に写す行も書かない", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/work/loop.ts" }]);
    const task = await openedPull(world, OFFICE);
    let moved = false;
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        if (!moved) {
          moved = true;
          await world.d1.DB.prepare("UPDATE reviews SET head_sha = ? WHERE node_id = ?").bind(SHA.next, task).run();
        }
        return real(statements);
      },
    });
    try {
      await expect(reviewerApproves(world, SHA.head)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      restore();
    }
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ reviewer_verdict: null }]);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM github_mirrors")).toEqual([{ n: 0 }]);
  });

  it("レビュー担当が古い先で差し戻すと 409 で断り、作った社員のタスクを戻さない", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/work/loop.ts" }]);
    const task = await openedPull(world, OFFICE);
    await synchronize(world, OFFICE, SHA.next);
    await expect(tool(world, "reviewer", "review_submit", { verdict: "reject", summary: "テストが足りない", headSha: SHA.head })).rejects.toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ reviewer_verdict: null }]);
  });

  it("know-office 自身のリポジトリで compare が 300 件で切れたら、守りの PR は main に入れず merge_refused を残す", async () => {
    repoOnGitHub(world, OFFICE, [{ filename: "apps/office/src/gate/guard/observe.ts" }]);
    const task = await openedPull(world, OFFICE);
    world.gate.github.files = [{ filename: "apps/office/src/gate/guard/observe.ts" }, ...Array.from({ length: 299 }, (_, i) => ({ filename: `src/f${String(i)}.ts` }))];
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: SHA.head });
    expect(await reviewerApproves(world)).toBe(false);
    expect(mainMoves(world, OFFICE)).toEqual([]);
    expect((await events(world, task)).findLast((e) => e.kind === "merge_refused")).toEqual({ kind: "merge_refused", detail: { reason: "変えたファイルを確かめ切れない" } });
  });
});
