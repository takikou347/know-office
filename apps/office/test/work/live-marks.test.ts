// タスクの木の 1 件が変わった印。承認でタスクが動いた時、配信 DO に id だけの印を渡し、画面が GET で読み直す (社員と自動の 3.7)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, clockIn, idOf, purposeAndGoal, staffOf, tool, useWork } from "../helpers/work.ts";

const world = useWork();

describe("配信の印", () => {
  it("承認でタスクが todo に戻ると、そのタスクの印を id だけで配る", async () => {
    await clockIn(world, "builder");
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "勤怠の表", taskKind: "build", assignee: "builder", priority: 1 }, 201));
    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "ask_owner", { kind: "external_integration", target: "Slack", reason: "通知を Slack に送る" });
    const [approval] = z.array(z.object({ id: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/approvals"));
    world.gate.live.published.length = 0;
    await api(world, "POST", `/api/v1/approvals/${String(approval?.id)}/decision`, { decision: "reject", reason: "今はつながない" });
    const marks = world.gate.live.published.filter((e) => z.object({ type: z.literal("node") }).loose().safeParse(e).success);
    // 戻ったタスクを社員がまた取ると、その出来事でも印が出る。どの印も id だけを持つ
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark).toEqual({ type: "node", node: { id: task } });
  });
});
