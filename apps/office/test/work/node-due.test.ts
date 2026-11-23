// 目標とタスクの期限。作る時に付け、後から変え、消せる (API の nodes、タスクとレビューの 3.1)
import { describe, expect, it } from "vitest";
import { api, idOf, purposeAndGoal, useWork } from "../helpers/work.ts";

const world = useWork();

describe("目的からタスクまでの木", () => {
  it("目標を期限付きで作ると、木に期限が出る", async () => {
    const { purpose } = await purposeAndGoal(world);
    const goal = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "goal", parentId: purpose, scope: "office", title: "勤怠を出す", dueDay: "2026-12-24" }, 201));
    const read = await api(world, "GET", `/api/v1/nodes/${goal}`, undefined, 200);
    expect(read).toMatchObject({ dueDay: "2026-12-24" });
  });

  it("目標を期限付きで足し、後から期限を変えて消せる", async () => {
    const { goal } = await purposeAndGoal(world);
    const changed = await api(world, "PATCH", `/api/v1/nodes/${goal}`, { version: 1, dueDay: "2027-01-31" }, 200);
    expect(changed).toMatchObject({ dueDay: "2027-01-31", version: 2 });
    const cleared = await api(world, "PATCH", `/api/v1/nodes/${goal}`, { version: 2, dueDay: null }, 200);
    expect(cleared).toMatchObject({ dueDay: null, version: 3 });
  });

  it("期限を付けなければ null", async () => {
    const { goal } = await purposeAndGoal(world);
    expect(await api(world, "GET", `/api/v1/nodes/${goal}`, undefined, 200)).toMatchObject({ dueDay: null });
  });

  it("日の形でない期限と、無い日は 422 で断る", async () => {
    const { purpose } = await purposeAndGoal(world);
    for (const dueDay of ["2026/12/24", "2026-02-30", "2026-12-24T00:00:00Z"]) {
      expect(await api(world, "POST", "/api/v1/nodes", { kind: "goal", parentId: purpose, scope: "office", title: "形の違う期限", dueDay }, 422)).toMatchObject({ code: "validation_failed" });
    }
  });
});
