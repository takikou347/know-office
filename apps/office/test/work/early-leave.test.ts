// 早い退勤の中央値。終わりの 15 分前に新しいタスクを取るかを、同じ社員の同じ種類のした仕事の直前 7 日の中央値で決める (社員と勤怠の 3 章)
import { describe, expect, it } from "vitest";
import { advance, api, at, clockIn, idOf, purposeAndGoal, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * した仕事を 1 行置く。タスクの種類は付けたタスクから読む
 * @param nodeId タスク ID
 * @param endedAt 終えた時刻
 * @param activeMs 働いた時間
 * @param result 結果
 * @param staffId 社員 ID
 */
async function worked(nodeId: string, endedAt: number, activeMs: number, result = "done", staffId = "builder"): Promise<void> {
  const day = new Date(endedAt + 9 * 3_600_000).toISOString().slice(0, 10);
  await world.d1.DB.prepare("INSERT INTO work_entries (id, staff_id, day, node_id, scope, title, started_at, ended_at, active_ms, result) VALUES (?, ?, ?, ?, 'office', '前の仕事', ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), staffId, day, nodeId, endedAt - activeMs, endedAt, activeMs, result)
    .run();
}

/**
 * 前の作る仕事を置いてから 16 時 46 分 (残り 14 分) に作る仕事を頼み、開発担当が取ったかを返す
 * @param past 前の作る仕事。何日前に終えたか、働いた分、社員
 * @returns 取ったか
 */
async function takesAt1646(past: { daysAgo: number; minutes: number; staffId?: string }[]): Promise<boolean> {
  const { goal } = await purposeAndGoal(world);
  const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
  const earlier = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "前の作る仕事", taskKind: "build" }, 201));
  for (const p of past) await worked(earlier, at(16, 46) - p.daysAgo * 24 * 3_600_000, p.minutes * 60_000, "done", p.staffId);
  await clockIn(world, "builder");
  await advance(world, at(16, 46));
  const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "今の作る仕事", taskKind: "build", assignee: "builder" }, 201));
  return (await doing("builder")) === task;
}

/**
 * 社員が今持っているタスクを読む
 * @param staffId 社員 ID
 * @returns タスク ID。無ければ null
 */
async function doing(staffId: "builder"): Promise<string | null> {
  return (await world.gate.staff[staffId].book.status(world.clock.now())).nodeId;
}

describe("早い退勤の中央値", () => {
  it("中央値が残りとちょうど同じなら取る。偶数の行は真ん中の 2 つの平均にする", async () => {
    expect(await takesAt1646([{ daysAgo: 1, minutes: 12 }, { daysAgo: 2, minutes: 16 }])).toBe(true);
  });

  it("中央値はちょうど 7 日前に終えた仕事まで数える", async () => {
    // 7 日前の 30 分を数えると (1 + 30) / 2 = 15.5 分で、残りの 14 分より長い
    expect(await takesAt1646([{ daysAgo: 1, minutes: 1 }, { daysAgo: 2, minutes: 1 }, { daysAgo: 3, minutes: 30 }, { daysAgo: 7, minutes: 30 }])).toBe(false);
  });

  it("中央値にほかの社員のした仕事を数えない", async () => {
    expect(await takesAt1646([{ daysAgo: 1, minutes: 1 }, ...[1, 2, 3].map((d) => ({ daysAgo: d, minutes: 60, staffId: "reviewer" }))])).toBe(true);
  });

  it("終わりの 15 分前は、同じ種類のタスクの直前 7 日の中央値が残りより長ければ取らずに退勤する", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    const make = async (title: string, taskKind: string) => idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title, taskKind }, 201));
    const pastBuild = await make("前の作る仕事", "build");
    const pastFix = await make("前の直し", "fix");
    const DAY_MS = 24 * 3_600_000;
    // 作る仕事は 20、30、40 分で中央値 30 分。直しと 8 日前と止めた仕事は数えない
    await worked(pastBuild, at(12) - DAY_MS, 20 * 60_000);
    await worked(pastBuild, at(12) - 2 * DAY_MS, 30 * 60_000, "continued");
    await worked(pastBuild, at(12) - 6 * DAY_MS, 40 * 60_000);
    await worked(pastBuild, at(12) - 8 * DAY_MS, 1 * 60_000);
    await worked(pastBuild, at(12) - DAY_MS, 1 * 60_000, "stopped");
    await worked(pastFix, at(12) - DAY_MS, 1 * 60_000);
    await worked(pastFix, at(12) - 2 * DAY_MS, 1 * 60_000);
    await clockIn(world, "builder");
    await advance(world, at(16, 46));
    const fix = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "短い直し", taskKind: "fix", assignee: "builder", priority: 2 }, 201));
    // 直しの中央値は 1 分で残り 14 分より短いので取る
    expect(await doing("builder")).toBe(fix);
    await world.gate.staff.builder.book.finish("done", at(16, 46));
    await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "長い仕事", taskKind: "build", assignee: "builder" }, 201);
    expect(await world.gate.staff.builder.book.status(at(16, 46))).toMatchObject({ state: "off", nodeId: null });
  });
});
