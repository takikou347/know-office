// 設計書を同じ時に直す、2 つの PR を main に入れるテストの手伝い。設計書の PR とコードの PR を出して承認し、入れた結果を読む (開発の回し方の 3.6)
import { expect } from "vitest";
import { z } from "zod";
import { REPO } from "./docs.ts";
import { CODE_HEAD, working } from "./docs-together.ts";
import { advance, at, rows, staffOf, tool, type WorkWorld } from "./work.ts";
import { findNode } from "../../src/gate/work/nodes.ts";
import { mergeIfReady } from "../../src/gate/work/review.ts";

/**
 * 設計書の PR とコードの PR を出し、レビュー担当がレビューを取る直前まで進める
 * @param world テストの物
 * @returns サービス ID、タスク ID、Issue の番号、代わりの GitHub の記録
 */
export async function reviewed(world: WorkWorld) {
  const made = await working(world);
  const docs = z.object({ number: z.number() }).parse(JSON.parse((await tool(world, "builder", "docs_pr_open", { name: "spec", title: "設計書", body: "" })).content));
  expect(await tool(world, "builder", "pr_open", { name: "make", title: "動画を作る", body: "", docsPr: docs.number })).toMatchObject({ isError: false });
  await advance(world, at(10));
  await staffOf(world, "reviewer").pull(world.clock.now());
  return made;
}

/**
 * レビュー担当が承認する
 * @param world テストの物
 * @returns main に入れたか
 */
export async function approve(world: WorkWorld): Promise<boolean> {
  const answer = await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "設計書とコードを確かめた", headSha: CODE_HEAD });
  return z.object({ merged: z.boolean() }).parse(JSON.parse(answer.content)).merged;
}

/**
 * 承認の後にもう一度入れようとする (オーナーの押し直しの代わり)
 * @param world テストの物
 * @param task タスク ID
 * @param stale 読んだ後に変わったタスクの版にするか
 * @returns main に入れたか
 */
export async function retry(world: WorkWorld, task: string, stale = false): Promise<boolean> {
  const made = await findNode(world.gate.env.DB, task);
  const given = stale ? { ...made, version: made.version - 1 } : made;
  return mergeIfReady(world.gate.env, world.forge, given, { repo: REPO, branch: `ko/${task.slice(0, 8)}-make`, prNumber: 1, reviewer: null }, { staffId: null, kind: "owner_approved", detail: {} }, { by: "owner", now: world.clock.now() }, world.gate.deps);
}

/**
 * タスクの状態を読む
 * @param world テストの物
 * @param task タスク ID
 * @returns 状態
 */
export async function statusOf(world: WorkWorld, task: string): Promise<unknown> {
  return (await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task))[0]?.["status"];
}

/**
 * 子 Issue の要件のハッシュを読む
 * @param world テストの物
 * @returns ハッシュ
 */
export async function reqHash(world: WorkWorld): Promise<unknown> {
  return (await rows(world.d1.DB, "SELECT req_hash FROM dev_issues WHERE kind = 'child'"))[0]?.["req_hash"];
}
