// レビューの確かめ直しのテスト (review-again) が使う道具。代わりの GitHub への通知、社員のツール、レビューの行とタスクの読み (タスクとレビューの 3.1、GitHub の連携の 3.3、タスクとレビューの 3.2)
import type { StaffId } from "@know-office/core";
import { expect } from "vitest";
import { z } from "zod";
import type { Forge } from "../../src/gate/work/loop.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { type Connected, hook } from "./github.ts";
import { appForge, eventsOf, HEAD } from "./review.ts";
import { REPO, rows, type WorkWorld } from "./work.ts";

/** 先が進んだ後の先 */
export const NEXT = "c".repeat(40);
/** もう一度進んだ後の先 */
export const NEWER = "e".repeat(40);
/** 開発担当が出し直す時の入力 */
export const AGAIN = { title: "勤怠の表をつなぐ", body: "空の日のテストを足した" };

/**
 * 社員のツールを、代わりの GitHub につないだ口で呼ぶ
 * @param w テストの物
 * @param staffId 呼ぶ社員
 * @param name ツールの名前
 * @param input 入力
 * @param forge GitHub を呼ぶ口。無ければ vault の App の鍵で呼ぶ口
 * @returns ツールの答え
 */
export function tool(w: WorkWorld, staffId: StaffId, name: string, input: unknown, forge: Forge = appForge(w)) {
  return runTool(w.gate.env, forge, { staffId, tool: name, input, now: w.clock.now(), guard: w.gate.deps });
}

/**
 * コミットのチェックをまだ終わっていない物にする。レビュー担当が承認しても main に入れず待たせる
 * @param w テストの物
 * @param shas チェックを置くコミット
 */
export function checksRunning(w: WorkWorld, ...shas: string[]): void {
  for (const sha of shas) w.gate.github.set(`GET /repos/${REPO}/commits/${sha}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "in_progress", conclusion: null }] });
}

/**
 * プルリクエストの先が進んだ通知 (synchronize) を送る
 * @param w テストの物
 * @param c 連携
 * @param sha 新しい先
 */
export async function synchronize(w: WorkWorld, c: Connected, sha: string): Promise<void> {
  const payload = { action: "synchronize", pull_request: { number: 1, head: { sha } }, repository: { full_name: REPO }, installation: { id: c.installationId } };
  expect((await hook(w, { event: "pull_request", payload, secret: c.webhookSecret })).status).toBe(204);
}

/**
 * レビュー担当の開いたレビューのタスク (todo か doing)
 * @param w テストの物
 * @returns タスクの ID と状態とプルリクエストの番号
 */
export function openReviewTasks(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT id, status, pr_number FROM nodes WHERE task_kind = 'review' AND assignee = 'reviewer' AND status IN ('todo', 'doing') ORDER BY id");
}

/**
 * レビュー担当が取った、開いたレビューのタスクが 1 つだけある形
 * @param pr プルリクエストの番号
 * @returns openReviewTasks と比べる物
 */
export function oneOpen(pr: number): unknown[] {
  return [{ id: expect.any(String) as unknown, status: "doing", pr_number: pr }];
}

/**
 * レビュー担当が今のレビューのタスクで判断を出す
 * @param w テストの物
 * @param verdict 承認か差し戻し
 * @param headSha 読んだ先
 */
export async function reviewerSays(w: WorkWorld, verdict: "approve" | "reject", headSha: string): Promise<void> {
  expect(await tool(w, "reviewer", "review_submit", { verdict, summary: verdict === "approve" ? "確かめた。未確認の所は無い" : "空の日のテストが無い", headSha })).toMatchObject({ isError: false });
}

/**
 * 開発担当のブランチを読む
 * @param w テストの物
 * @param task 開発担当のタスク
 * @returns ブランチ
 */
export async function branchOf(w: WorkWorld, task: string): Promise<string> {
  return z.object({ branch: z.string() }).parse((await rows(w.d1.DB, "SELECT branch FROM reviews WHERE node_id = ?", task))[0]).branch;
}

/**
 * 代わりの GitHub が受けた、プルリクエストを出す要求の数
 * @param w テストの物
 * @returns 数
 */
export function pullsOpened(w: WorkWorld): number {
  return w.gate.github.requests.filter((r) => r.route === `POST /repos/${REPO}/pulls`).length;
}

/**
 * レビュー担当が差し戻し、開発担当がタスクを取り直すところまで進める
 * @param w テストの物
 * @param task 開発担当のタスク
 * @param headSha レビュー担当が読んだ先
 */
export async function rejected(w: WorkWorld, task: string, headSha = HEAD): Promise<void> {
  await reviewerSays(w, "reject", headSha);
  // 戻ったタスクは、手の空いた開発担当がすぐに取る
  expect(await rows(w.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
}

/**
 * タスクの出来事のうち、プルリクエストを出した物の中身
 * @param w テストの物
 * @param task タスク
 * @returns 中身
 */
export async function prOpened(w: WorkWorld, task: string): Promise<unknown[]> {
  return (await eventsOf(w, task)).filter((e) => e.kind === "pr_opened").map((e) => e.detail);
}

/**
 * 文の SQL を読む。手元の D1 の文は、組み立てた SQL を statement に持つ
 * @param statement 文
 * @returns SQL
 */
export function sqlOf(statement: unknown): string {
  return z.object({ statement: z.string() }).loose().catch({ statement: "" }).parse(statement).statement;
}

/**
 * レビューの今の先を読む
 * @param w テストの物
 * @param task 開発担当のタスク
 * @returns 先
 */
export async function headOf(w: WorkWorld, task: string): Promise<string> {
  return z.object({ head_sha: z.string() }).parse((await rows(w.d1.DB, "SELECT head_sha FROM reviews WHERE node_id = ?", task))[0]).head_sha;
}

/**
 * 代わりの GitHub の上で、プルリクエストを閉じるか入れる
 * @param w テストの物
 * @param pr プルリクエストの番号
 * @param state 新しい状態
 */
export function setPullState(w: WorkWorld, pr: number, state: "closed" | "merged"): void {
  const key = `${REPO}#${String(pr)}`;
  const found = w.gate.github.pullRequests.get(key);
  if (!found) throw new Error(`プルリクエスト ${String(pr)} が無い`);
  w.gate.github.pullRequests.set(key, { ...found, state });
}
