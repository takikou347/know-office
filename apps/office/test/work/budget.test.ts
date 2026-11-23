// Claude の API の月の予算。今日の配分に届いた社員は呼び出しを始めず、1 タスクの費用が上限を超えたらタスクを止める (社員が考えるの 3.10)
import { dailyAllowanceMicroUsd } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTaskCost } from "../../src/gate/guard/observe.ts";
import { startRun } from "../../src/gate/work/run.ts";
import { resumeRun } from "../../src/gate/work/transcript.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

/**
 * 2026-12-01 (日本時間) の時刻を返す
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
function at(h: number, m = 0): number {
  return Date.UTC(2026, 11, 1, h - 9, m);
}
const TASK = "019a7b00-0000-7000-8000-0000000000b1";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
beforeEach(async () => {
  clock = fixedClock(at(10));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  await d1.DB.prepare(
    "INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', '題', '本文', 'todo', 1, 'builder', 'build', NULL, 'president', 0, 0)",
  )
    .bind(TASK)
    .run();
});
afterEach(() => d1.dispose());

/**
 * 使った額を usage に 1 行足す
 * @param when 時刻
 * @param micro 百万分の 1 ドル
 * @param nodeId タスク ID
 */
async function spend(when: number, micro: number, nodeId: string | null = null): Promise<void> {
  await d1.REC_2026.prepare(
    "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd) VALUES (?, ?, 'builder', ?, 'office', 'claude-sonnet-5-5', 0, 0, 0, 0, ?)",
  )
    .bind(crypto.randomUUID(), when, nodeId, micro)
    .run();
}

/**
 * 開発担当を出勤させ、タスクを取らせて最初の呼び出しを始めさせる
 * @returns 始めた結果
 */
async function takeAndStart(): Promise<string> {
  const now = clock.now();
  await gate.staff.builder.book.wake(now - 2 * 60 * 60 * 1000);
  await gate.staff.builder.book.wake(now - 60 * 60 * 1000);
  await gate.staff.builder.book.heartbeat(now);
  await gate.env.STAFF.get(gate.env.STAFF.idFromName("builder")).pull(now);
  return startRun(gate.env, "builder", now);
}

describe("月の予算で配分する", () => {
  it("今月の残りを残りの日数で割る", () => {
    // 12 月 1 日は 31 日、30 日は 2 日残る
    expect(dailyAllowanceMicroUsd(90_000_000, 0, "2026-12-01")).toBe(Math.floor(90_000_000 / 31));
    expect(dailyAllowanceMicroUsd(90_000_000, 80_000_000, "2026-12-30")).toBe(5_000_000);
    expect(dailyAllowanceMicroUsd(90_000_000, 90_000_000, "2026-12-31")).toBe(0);
    // 月の最終日は残りを全部、2 月は 28 日か閏年の 29 日で割る
    expect(dailyAllowanceMicroUsd(90_000_000, 87_000_000, "2026-12-31")).toBe(3_000_000);
    expect(dailyAllowanceMicroUsd(28_000_000, 0, "2027-02-01")).toBe(1_000_000);
    expect(dailyAllowanceMicroUsd(29_000_000, 0, "2028-02-01")).toBe(1_000_000);
  });

  it("日本時間の月の境目で今月の額を数え直す", async () => {
    // 11 月 30 日 23:59 (日本時間) の費用は 12 月に数えない。12 月 1 日 0:00 の物は数える
    const firstOfMonth = Date.UTC(2026, 10, 30, 15, 0);
    await spend(firstOfMonth - 60_000, 80_000_000);
    expect(await takeAndStart()).toBe("started");
    await spend(firstOfMonth, 3_000_000);
    expect(await startRun(gate.env, "builder", clock.now())).not.toBe("started");
  });

  it("配分の内なら呼び出しを始める", async () => {
    // 配分 2,903,225 の 1 つ手前まで使っても始める
    await spend(at(9), Math.floor(90_000_000 / 31) - 1);
    expect(await takeAndStart()).toBe("started");
  });

  it("今日の配分に届く", async () => {
    // 初期値の 90 ドルを 31 日で割ると 1 日 2.90 ドル
    await spend(at(9), 3_000_000);
    expect(await takeAndStart()).toBe("paced");
    expect(gate.workspaces.builder.runs).toHaveLength(0);
    expect(await startRun(gate.env, "builder", clock.now())).toBe("paced");
    const notices = await d1.DB.prepare("SELECT title FROM notices WHERE kind = 'claude_budget_paced'").all<{ title: string }>();
    expect(notices.results).toHaveLength(1);
    expect(notices.results[0]?.title).toContain("2026-12-01");
  });

  it("配分ちょうどで止め、続きの呼び出しも始めない", async () => {
    expect(await takeAndStart()).toBe("started");
    await gate.env.STAFF.get(gate.env.STAFF.idFromName("builder")).appendTranscript(TASK, { sessionId: crypto.randomUUID(), seq: 0, chunk: btoa("{}\n") }, clock.now());
    await spend(at(9), Math.floor(90_000_000 / 31));
    expect(await resumeRun(gate.env, "builder", clock.now())).toBe(false);
    expect(gate.workspaces.builder.runs).toHaveLength(1);
  });
});

describe("タスクを止めるシグナル", () => {
  it("1 つのタスクの費用の上限", async () => {
    await spend(at(9), 600_000, TASK);
    expect(await checkTaskCost(gate.env, { staffId: "builder", nodeId: TASK }, at(9, 1), gate.deps)).toBe(false);
    await spend(at(9, 2), 600_000, TASK);
    expect(await checkTaskCost(gate.env, { staffId: "builder", nodeId: TASK }, at(9, 3), gate.deps)).toBe(true);
    const stop = await d1.DB.prepare("SELECT id, signal, measured, threshold FROM stops WHERE target = ?").bind(TASK).first<{ id: string; signal: string; measured: number; threshold: number }>();
    expect(stop).toMatchObject({ signal: "task_cost", measured: 1_200_000, threshold: 1_000_000 });
    await d1.DB.prepare("INSERT INTO stop_updates (id, stop_id, at, kind, by) VALUES (?, ?, ?, 'resumed', 'owner')").bind(crypto.randomUUID(), stop?.id, at(9, 4)).run();
    await spend(at(9, 5), 500_000, TASK);
    expect(await checkTaskCost(gate.env, { staffId: "builder", nodeId: TASK }, at(9, 6), gate.deps)).toBe(false);
  });
});
