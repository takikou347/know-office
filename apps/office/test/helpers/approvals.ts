// 承認のテストで使う道具。承認を求めさせる、確かめた事にする、取り直したタスクの始めの中身を読む
import { expect } from "vitest";
import { z } from "zod";
import { finishTask } from "../../src/gate/work/loop.ts";
import { wrapDb } from "./github.ts";
import { api, clockIn, idOf, MINUTE, purposeAndGoal, rows, staffOf, tool, type WorkWorld } from "./work.ts";

/** 承認の一覧の 1 行のうち、テストが読む所 */
export const ApprovalRow = z.object({ id: z.string(), kind: z.string(), status: z.string(), reason: z.string().nullable() }).loose();

/** 社員のツールが返す承認の答え */
export const Answer = z.object({ approvalId: z.string(), status: z.string(), reason: z.string().nullable().optional(), note: z.string().optional() }).strict();

/**
 * 承認かタスクの今の状態を読む
 * @param w テストの物
 * @param table 承認かタスク
 * @param id ID
 * @returns 状態
 */
export async function statusOf(w: WorkWorld, table: "approvals" | "nodes", id: string): Promise<unknown> {
  return (await rows(w.d1.DB, `SELECT status FROM ${table} WHERE id = ?`, id))[0]?.["status"];
}

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
export async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 開発担当のタスクを 1 つ作って取らせ、ask_owner で承認を求めさせる
 * @param w テストの物
 * @param kind 外部連携か費用の増える事
 * @returns 承認 ID とタスク ID
 */
export async function asked(w: WorkWorld, kind: "external_integration" | "cost_increase"): Promise<{ approvalId: string; nodeId: string }> {
  // 勤務の前にオーナーがタスクを足すと呼び出しになり、タスクを離れると退勤するので、先に出勤させる
  await clockIn(w, "builder");
  const { goal } = await purposeAndGoal(w);
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "通知" }, 201));
  const nodeId = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "通知を外へ送る", taskKind: "build", assignee: "builder", priority: 1 }, 201));
  // 答えを待つ間に進める 2 つ目のタスク
  await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "通知の文を直す", taskKind: "build", assignee: "builder", priority: 2 }, 201);
  await staffOf(w, "builder").pull(w.clock.now());
  expect(await tool(w, "builder", "ask_owner", { kind, target: kind === "external_integration" ? "Slack" : "Workers の有料プラン", reason: "要件に要る" })).toMatchObject({ isError: false });
  const [approval] = z.array(ApprovalRow).parse(await api(w, "GET", "/api/v1/approvals"));
  return { approvalId: String(approval?.id), nodeId };
}

/**
 * 開発担当の今のタスクを終える
 * @param w テストの物
 */
export async function finishCurrent(w: WorkWorld): Promise<void> {
  const { nodeId } = await w.gate.staff.builder.book.status(w.clock.now());
  await finishTask(w.gate.env, "builder", String(nodeId), w.clock.now());
}

/**
 * タスクの出来事のうち、始めた時の中身を新しい順に読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns started の中身
 */
export async function startedDetails(w: WorkWorld, nodeId: string): Promise<unknown[]> {
  const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.unknown() })) }).loose().parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  return detail.events.filter((e) => e.kind === "started").map((e) => e.detail);
}

/**
 * バッチの最後に必ず落ちる文を足し、バッチ全体を落とす。D1 のバッチは 1 つが落ちると全部を戻す
 * @param w テストの物
 * @returns 元に戻す関数
 */
export function failBatches(w: WorkWorld): () => void {
  return wrapDb(w, { batch: (real, statements) => real([...statements, w.d1.DB.prepare("INSERT INTO no_such_table VALUES (1)")]) });
}
