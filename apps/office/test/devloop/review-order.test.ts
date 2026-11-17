// 社員の PR が同じ時に main に入る順番。古い main の上で確かめた PR は、main が進んだ後には入らず、作った社員に戻って rebase を求める (タスクとレビューの 3.1 の 5)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { advance, api, at, clockIn, purposeAndGoal, REPO, rows, staffOf, tool, useWork } from "../helpers/work.ts";
import { findNode } from "../../src/gate/work/nodes.ts";
import { mergeIfReady } from "../../src/gate/work/review.ts";
import { type ToolResult } from "@know-office/core";

const world = useWork();

/**
 * 契約の通りに JSON を読む
 * @param result ツールの答え
 * @returns 読んだ物
 */
function read(result: ToolResult): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.content));
}

/**
 * 開発担当に 2 つのタスクを渡し、どちらも PR を出して、レビュー待ちにする。2 つの PR は同じ main の先の上にある
 * @returns 2 つのタスク ID
 */
async function twoPullRequests(): Promise<[string, string]> {
  const { goal } = await purposeAndGoal(world);
  await clockIn(world, "president", "builder", "reviewer");
  const project = String(read(await tool(world, "president", "node_create", { kind: "project", parentId: goal, title: "勤怠" }))["id"]);
  const ids: string[] = [];
  for (const title of ["勤怠の表をつなぐ", "勤怠の訂正を出す"]) {
    ids.push(String(read(await tool(world, "president", "node_create", { kind: "task", parentId: project, title, taskKind: "build", repo: REPO, assignee: "builder" }))["id"]));
  }
  await staffOf(world, "builder").pull(world.clock.now());
  expect(await tool(world, "builder", "pr_open", { name: "table", title: "表", body: "" })).toMatchObject({ isError: false });
  expect(await tool(world, "builder", "pr_open", { name: "fix", title: "訂正", body: "" })).toMatchObject({ isError: false });
  return [ids[0] ?? "", ids[1] ?? ""];
}

/**
 * レビュー担当が今のレビューのタスクを承認する
 * @param headSha 確かめたコミット
 * @returns 答え
 */
async function approve(headSha = "b".repeat(40)): Promise<Record<string, unknown>> {
  await advance(world, world.clock.now());
  return read(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "確かめた", headSha }));
}

/**
 * タスクの状態を読む
 * @param id タスク ID
 * @returns 状態
 */
async function statusOf(id: string): Promise<unknown> {
  return (await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", id))[0]?.["status"];
}

describe("古い main の上で確かめた PR は入らない", () => {
  it("同じ main から出した 2 つのうち、先に承認した 1 つだけが入る", async () => {
    const [first, second] = await twoPullRequests();
    expect(await approve()).toEqual({ merged: true });
    // 2 つ目の PR は古い main の上にあるので入らず、例外にもならない。作った社員のタスクに戻る
    expect(await approve()).toEqual({ merged: false });
    expect(world.forge.merged).toHaveLength(1);
    expect(await statusOf(first)).toBe("done");
    expect(await statusOf(second)).toBe("doing");
    const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.record(z.string(), z.unknown()) })) }).loose().parse(await api(world, "GET", `/api/v1/nodes/${second}`));
    expect(detail.events.map((e) => e.kind)).toContain("main_advanced");
  });

  it("rebase して出し直せば入る", async () => {
    const [, second] = await twoPullRequests();
    await approve();
    await approve();
    // 作った社員が main の先に rebase して push し直し、先が変わったので出し直す。承認は消えているので、レビューを受け直す
    world.forge.baseOf["ko/" + second.slice(0, 8) + "-fix"] = world.forge.main;
    world.forge.branchHead = () => Promise.resolve("d".repeat(40));
    expect(await tool(world, "builder", "pr_open", { name: "fix", title: "訂正", body: "" })).toMatchObject({ isError: false });
    expect(await rows(world.d1.DB, "SELECT head_sha, reviewer_verdict FROM reviews WHERE node_id = ?", second)).toEqual([{ head_sha: "d".repeat(40), reviewer_verdict: null }]);
    expect(await approve("d".repeat(40))).toEqual({ merged: true });
    expect(world.forge.merged).toHaveLength(2);
    expect(await statusOf(second)).toBe("done");
  });

  it("同時に承認された 2 つのうち 1 つだけが入る", async () => {
    const [first, second] = await twoPullRequests();
    await world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve' WHERE node_id IN (?, ?)").bind(first, second).run();
    // 1 つ目が main を進める前に、2 つ目が確かめを終えて同じ main の先を見ている
    world.forge.during.merge = () => Promise.resolve();
    const run = async (id: string) => {
      const made = await findNode(world.d1.DB, id);
      const branch = `ko/${id.slice(0, 8)}-${id === first ? "table" : "fix"}`;
      return mergeIfReady(world.gate.env, world.forge, made, { repo: made.repo ?? "", branch, prNumber: made.prNumber ?? 0, reviewer: null }, { staffId: null, kind: "owner_approved", detail: {} }, { by: "owner", now: world.clock.now() }, world.gate.deps);
    };
    const results = await Promise.all([run(first), run(second)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(world.forge.merged).toHaveLength(1);
    // 入らなかった側は done に残らず、作った社員に戻る
    const states = [await statusOf(first), await statusOf(second)];
    expect(states.filter((s) => s === "done")).toHaveLength(1);
    expect(states.filter((s) => s === "done" || s === "doing" || s === "todo")).toHaveLength(2);
  });

  it("入れられなかった時、勤務時間外の社員は呼び出さない", async () => {
    const [, second] = await twoPullRequests();
    await approve();
    // 勤務時間の後に、2 つ目を承認する
    await advance(world, at(17));
    await world.gate.staff.builder.book.wake(at(17));
    expect(await staffOf(world, "builder").status(at(17))).toMatchObject({ state: "off" });
    expect(await approve()).toEqual({ merged: false });
    expect(await statusOf(second)).toBe("todo");
  });
});
