// 別のモデルによる確認。レビュー担当の差し戻しが、理由と一緒に作った社員のタスクに戻る (タスクとレビューの 3.1 の 4)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, at, advance, clockIn, purposeAndGoal, REPO, rows, staffOf, tool, useWork } from "../helpers/work.ts";

const world = useWork();

describe("別のモデルによる確認", () => {
  it("レビュー担当が差し戻しを出す", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder", "reviewer");
    await staffOf(world, "builder").pull(world.clock.now());
    await staffOf(world, "president").pull(world.clock.now());
    const project = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "project", parentId: goal, title: "勤怠" })).content)).id;
    const task = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "task", parentId: project, title: "勤怠の表をつなぐ", taskKind: "build", repo: REPO, assignee: "builder" })).content)).id;
    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());

    await advance(world, at(9, 40));
    expect(await tool(world, "reviewer", "review_submit", { verdict: "reject", summary: "空の日の表のテストが無い" })).toMatchObject({ isError: false });
    expect(world.forge.merged).toEqual([]);
    const detail = z.object({ events: z.array(z.object({ kind: z.string(), staffId: z.string().nullable(), detail: z.record(z.string(), z.unknown()) })) }).loose().parse(await api(world, "GET", `/api/v1/nodes/${task}`));
    expect(detail.events.find((e) => e.kind === "review_rejected")).toEqual({ kind: "review_rejected", staffId: "reviewer", detail: { summary: "空の日の表のテストが無い" } });
    // 戻ったタスクは、手の空いた開発担当がすぐに取る
    expect(await rows(world.d1.DB, "SELECT status, assignee FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing", assignee: "builder" }]);
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ nodeId: task });
    expect(detail.events.map((e) => e.kind)).toEqual(["created", "started", "pr_opened", "review_rejected", "started"]);
  });
});
