// 社員ごとのタスクの山。/nodes?assignee= で、その社員のタスクだけを ID の順に並べる (社員と勤怠の 3.4)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, idOf, purposeAndGoal, useWork } from "../helpers/work.ts";

const world = useWork();

const Item = z.object({ id: z.string(), kind: z.string(), assignee: z.string().nullable(), status: z.string(), children: z.array(z.unknown()) }).loose();

describe("社員ごとのタスクの山", () => {
  it("assignee を付けると、その社員のタスクだけを木にせず ID の順に、カーソルで続けて返す", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    const make = async (title: string, assignee: string) => idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title, taskKind: "build", assignee, priority: 1 }, 201));
    const a = await make("一", "builder");
    await make("二", "reviewer");
    const c = await make("三", "builder");
    const d = await make("四", "builder");
    // 同じミリ秒の ID は後ろの乱数で順が決まるので、ID の順に並べた物と比べる
    const sorted = [a, c, d].toSorted();
    const first = z.array(Item).parse(await api(world, "GET", "/api/v1/nodes?assignee=builder&limit=2"));
    expect(first.map((n) => n.id)).toEqual(sorted.slice(0, 2));
    expect(first.every((n) => n.kind === "task" && n.assignee === "builder" && n.children.length === 0)).toBe(true);
    const rest = z.array(Item).parse(await api(world, "GET", `/api/v1/nodes?assignee=builder&limit=2&cursor=${sorted[1] ?? ""}`));
    expect(rest.map((n) => n.id)).toEqual(sorted.slice(2));
    expect(z.array(Item).parse(await api(world, "GET", "/api/v1/nodes?assignee=builder&status=done"))).toEqual([]);
  });

  it("知らない社員 ID は 422 で断る", async () => {
    const res = await world.gate.request("/api/v1/nodes?assignee=nobody", { headers: world.headers });
    expect(res.status).toBe(422);
  });
});
