// 社員の名簿。在籍の社員の並び、職種からの割り当て、削除した社員の予定と呼び出しと書き込み (データの 2 章、タスクとレビューの 3.3)
import { newId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { previewStop } from "../../src/gate/guard/actions.ts";
import { type Actor, createNode, intakeProject } from "../../src/gate/work/nodes.ts";
import { planDay } from "../../src/gate/work/plan.ts";
import { activeStaff, pickStaff } from "../../src/gate/work/roster.ts";
import { runBase } from "../../src/gate/work/run.ts";
import { api, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();
const DAY = "2026-11-24";

/**
 * 社員の行を足す
 * @param w テストの物
 * @param id 社員 ID
 * @param options 職種、作った時刻、削除した時刻
 * @param options.job 職種
 * @param options.createdAt 作った時刻
 * @param options.retiredAt 削除した時刻
 */
async function hire(w: WorkWorld, id: string, options: { job: string; createdAt: number; retiredAt?: number }): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO staff (id, job, role, boss_id, model, effort, prompt_version, created_at, retired_at) VALUES (?, ?, ?, 'president', 'claude-sonnet-5-5', 'high', 1, ?, ?)")
    .bind(id, options.job, `${options.job} ${id}`, options.createdAt, options.retiredAt ?? null)
    .run();
}

/**
 * 社員を削除した事にする
 * @param w テストの物
 * @param id 社員 ID
 */
async function retire(w: WorkWorld, id: string): Promise<void> {
  await w.d1.DB.prepare("UPDATE staff SET retired_at = ? WHERE id = ?").bind(w.clock.now(), id).run();
}

/**
 * office の受け付けの下に、担当付きのタスクを足す
 * @param w テストの物
 * @param assignee 担当
 * @returns 足したタスクの ID
 */
async function task(w: WorkWorld, assignee: string): Promise<string> {
  const actor: Actor = { by: "owner", now: w.clock.now() };
  const project = await intakeProject(w.gate.env, "office", actor);
  return (await createNode(w.gate.env, { kind: "task", parentId: project.id, scope: "office", title: "名簿のタスク", taskKind: "build", assignee }, actor)).id;
}

/**
 * 失敗の元をたどって、文をつなげる
 * @param error 失敗
 * @returns 元までの文
 */
function chain(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) parts.push(e.message);
  return parts.join(" / ");
}

describe("社員の名簿", () => {
  it("在籍の社員だけを並べ、社長、作った順、ID の順にする", async () => {
    await hire(world, "reviewer-bbbbbb", { job: "reviewer", createdAt: 5 });
    await hire(world, "builder-aaaaaa", { job: "builder", createdAt: 5 });
    await hire(world, "builder-cccccc", { job: "builder", createdAt: 3, retiredAt: 4 });
    expect((await activeStaff(world.d1.DB)).map((s) => s.id)).toEqual(["president", "builder", "reviewer", "builder-aaaaaa", "reviewer-bbbbbb"]);
  });

  it("退職した社員の予定は無く、呼び出しを断る", async () => {
    expect(await planDay(world.d1.DB, "builder", DAY)).not.toBeNull();
    const nodeId = await task(world, "builder");
    await retire(world, "builder");
    expect(await planDay(world.d1.DB, "builder", DAY)).toBeNull();
    await expect(runBase(world.gate.env, "builder", nodeId, null)).rejects.toMatchObject({ code: "conflict" });
  });

  it("社員の行が無い ID の予定は無い", async () => {
    expect(await planDay(world.d1.DB, "builder-zzzzzz", DAY)).toBeNull();
  });

  it("割り当ては在籍の同じ職種で終わりでないタスクの少ない人を選ぶ", async () => {
    await hire(world, "builder-aaaaaa", { job: "builder", createdAt: 5 });
    await hire(world, "builder-dddddd", { job: "builder", createdAt: 1, retiredAt: 2 });
    // どちらも 0 件なら作った順で最初の開発担当
    expect(await pickStaff(world.d1.DB, "builder")).toBe("builder");
    await task(world, "builder");
    expect(await pickStaff(world.d1.DB, "builder")).toBe("builder-aaaaaa");
    // 終わったタスクは数えない
    await world.d1.DB.prepare("UPDATE nodes SET status = 'done' WHERE assignee = 'builder'").run();
    expect(await pickStaff(world.d1.DB, "builder")).toBe("builder");
  });

  it("読んだ後に退職になった社員にはタスクを割り当てない", async () => {
    await hire(world, "builder-aaaaaa", { job: "builder", createdAt: 5 });
    await task(world, "builder");
    const picked = await pickStaff(world.d1.DB, "builder");
    expect(picked).toBe("builder-aaaaaa");
    await retire(world, picked);
    await expect(task(world, picked).catch(chain)).resolves.toMatch(/assignee not active/);
    const moving = await task(world, "builder");
    await expect(world.d1.DB.prepare("UPDATE nodes SET assignee = ? WHERE id = ?").bind(picked, moving).run()).rejects.toThrow(/assignee not active/);
    expect(await rows(world.d1.DB, "SELECT id FROM nodes WHERE assignee = ?", picked)).toEqual([]);
  });

  it("全体の停止は退職した社員の DO も止める", async () => {
    await hire(world, "builder-cccccc", { job: "builder", createdAt: 3, retiredAt: 4 });
    expect((await previewStop(world.d1.DB, "office", "office")).staff).toEqual(["president", "builder", "reviewer", "builder-cccccc"]);
  });

  it("退職した社員の役の変更の承認と説明文の更新は書かない", async () => {
    const decide = async (target: string) => {
      const id = newId(world.clock);
      await world.d1.DB.prepare("INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES (?, 'role_change', ?, ?, 'pending', 'president', ?)")
        .bind(id, target, JSON.stringify({ target, role: "直した役", bossId: "president" }), world.clock.now())
        .run();
      await api(world, "POST", `/api/v1/approvals/${id}/decision`, { decision: "approve", reason: "直す" });
    };
    // 在籍の社員の役の変更は、設定の版を 1 上げる
    await decide("reviewer");
    expect(await rows(world.d1.DB, "SELECT role, version FROM staff WHERE id = 'reviewer'")).toEqual([{ role: "直した役", version: 2 }]);
    await retire(world, "builder");
    await decide("builder");
    expect(await rows(world.d1.DB, "SELECT role, version FROM staff WHERE id = 'builder'")).toEqual([{ role: "開発担当", version: 1 }]);
    await api(world, "PUT", "/api/v1/staff/builder/prompt", { version: 1, body: "削除した社員の説明文" }, 404);
  });

  it("組織図のカーソルは同じ作った時刻の 2 人でも抜けも重なりも出さない", async () => {
    await hire(world, "reviewer-bbbbbb", { job: "reviewer", createdAt: 5 });
    await hire(world, "builder-aaaaaa", { job: "builder", createdAt: 5 });
    const Page = z.object({ data: z.array(z.object({ id: z.string(), job: z.string() }).loose()), meta: z.object({ next: z.string().nullable() }).loose() });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "?limit=1" : `?limit=1&cursor=${cursor}`;
      const res = await world.gate.request(`/api/v1/org${query}`, { headers: world.headers });
      const page = Page.parse(await res.json());
      seen.push(...page.data.map((p) => p.id));
      cursor = page.meta.next;
    } while (cursor !== null);
    expect(seen).toEqual(["president", "builder", "reviewer", "builder-aaaaaa", "reviewer-bbbbbb"]);
  });
});
