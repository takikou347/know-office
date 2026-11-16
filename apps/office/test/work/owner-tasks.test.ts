// オーナーが画面から作るタスク。題、本文、種類、頼む先と一緒に、直すリポジトリを付けられる (ルートの一覧の 1.7)
import { describe, expect, it } from "vitest";
import { advance, api, at, idOf, purposeAndGoal, REPO, rows, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * 目標の下にプロジェクトを 1 つ置く
 * @returns プロジェクトの ID
 */
async function project(): Promise<string> {
  const { goal } = await purposeAndGoal(world);
  return idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
}

describe("オーナーが画面からタスクを作る", () => {
  it("付けたリポジトリをタスクに残す", async () => {
    const parentId = await project();
    const id = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "訂正を出す", taskKind: "build", repo: REPO }, 201));
    expect(await rows(world.gate.env.DB, "SELECT repo FROM nodes WHERE id = ?", id)).toEqual([{ repo: REPO }]);
  });

  it("owner/name の形でないリポジトリは 422 で断り、何も残さない", async () => {
    const parentId = await project();
    await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "訂正を出す", taskKind: "build", repo: "../know-office" }, 422);
    expect(await rows(world.gate.env.DB, "SELECT id FROM nodes WHERE kind = 'task'")).toEqual([]);
  });

  it("タスクでない物にリポジトリを付けると 422 で断る", async () => {
    const { goal } = await purposeAndGoal(world);
    const failed = await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠", repo: REPO }, 422);
    expect(failed).toMatchObject({ code: "validation_failed" });
  });

  it("時間外に呼び出した社員のタスクを止めると退勤し、次に頼んだタスクでまた呼び出す", async () => {
    const parentId = await project();
    await advance(world, at(21));
    world.headers = await world.gate.signIn();
    const make = async (title: string) => idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title, taskKind: "fix", assignee: "builder" }, 201));
    const first = await make("急ぎの直し");
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "called", nodeId: first });
    await api(world, "POST", "/api/v1/guard/stops", { scope: "task", target: first, reason: "頼み直す" }, 201);
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "off", nodeId: null });
    const second = await make("次の直し");
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "called", nodeId: second });
  });
});
