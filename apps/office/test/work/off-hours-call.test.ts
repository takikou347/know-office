// 時間外にオーナーが話しかけた時に、退勤している社員を呼び出す。設定で閉じて入れ、社員ごとの 1 日の回数で止める (社員と勤怠の 3.4)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startRun } from "../../src/gate/work/run.ts";
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
const TASK = "019a7b00-0000-7000-8000-0000000000a1";
const NEXT = "019a7b00-0000-7000-8000-0000000000a2";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  clock = fixedClock(at(21));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const Sent = z.object({ id: z.string() }).loose();
const RunCall = z.object({ prompt: z.string() }).loose();

/**
 * 開発担当のタスクを todo で置く
 * @param id タスク ID
 * @param title 題
 */
async function seedTask(id: string, title: string): Promise<void> {
  await d1.DB.prepare(
    "INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', ?, '本文', 'todo', 1, 'builder', 'build', NULL, 'president', 0, 0)",
  )
    .bind(id, title)
    .run();
}

/**
 * オーナーが開発担当に話しかける
 * @param body 本文
 * @returns 返事のステータスと data
 */
async function say(body: string): Promise<{ status: number; data: z.infer<typeof Sent> }> {
  const res = await gate.request("/api/v1/staff/builder/messages", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
  const json: unknown = await res.json();
  return { status: res.status, data: z.object({ data: Sent }).loose().parse(json).data };
}

/**
 * 渡した印の行を読む
 * @returns 行
 */
async function marks(): Promise<{ message_id: string; node_id: string | null; via: string }[]> {
  return (await d1.DB.prepare("SELECT message_id, node_id, via FROM message_deliveries ORDER BY message_id").all<{ message_id: string; node_id: string | null; via: string }>()).results;
}

/**
 * 時間外の呼び出しの設定を置く
 * @param value 設定の値
 */
async function setOffHoursCall(value: unknown): Promise<void> {
  await d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'workday.offHoursCall', 'office', ?, 1, 'owner', '通し', 0)")
    .bind("019a7b00-0000-7000-8000-00000000ffff", JSON.stringify(value))
    .run();
}

/**
 * タスクの今の状態を読む
 * @param id タスク ID
 * @returns 状態
 */
async function nodeStatus(id: string): Promise<string | undefined> {
  return (await d1.DB.prepare("SELECT status FROM nodes WHERE id = ?").bind(id).first<{ status: string }>())?.status;
}

describe("オーナーの指示に合わせる", () => {
  it("時間外の話しかけで呼び出す", async () => {
    await setOffHoursCall({ enabled: true, perDay: 2 });
    await seedTask(TASK, "勤怠の表を作る");
    headers = await gate.signIn();
    const sent = await say("今夜のうちに見て");
    expect(sent.status).toBe(201);
    // 話しかけた社員だけが呼ばれ、ほかの社員は退勤したまま
    expect(await gate.staff.builder.book.status(clock.now())).toMatchObject({ state: "called", nodeId: TASK });
    expect((await gate.staff.reviewer.book.status(clock.now())).state).toBe("off");
    expect(await nodeStatus(TASK)).toBe("doing");
    // 発言は最初の呼び出しの頭で渡す
    expect(await startRun(gate.env, "builder", clock.now())).toBe("started");
    expect(RunCall.parse(gate.workspaces.builder.runs.at(-1)).prompt).toContain('オーナーの発言 (日本時間 2026-12-01 21:00): "今夜のうちに見て"');
    expect(await marks()).toEqual([{ message_id: sent.data.id, node_id: TASK, via: "next_task" }]);
  });

  it("呼び出しが閉じていれば呼び出さない", async () => {
    await seedTask(TASK, "勤怠の表を作る");
    headers = await gate.signIn();
    expect((await say("今夜のうちに見て")).status).toBe(201);
    expect((await gate.staff.builder.book.status(clock.now())).state).toBe("off");
    expect(await nodeStatus(TASK)).toBe("todo");
    // 壊れた値も閉じているとみなす
    await setOffHoursCall({ enabled: "yes", perDay: 2 });
    expect((await say("もう一度")).status).toBe(201);
    expect((await gate.staff.builder.book.status(clock.now())).state).toBe("off");
  });

  it("取るタスクが無ければ呼び出さない", async () => {
    await setOffHoursCall({ enabled: true, perDay: 2 });
    headers = await gate.signIn();
    const sent = await say("明日の朝に見て");
    expect(sent.status).toBe(201);
    expect((await gate.staff.builder.book.status(clock.now())).state).toBe("off");
    expect(await marks()).toEqual([]);
  });

  it("1 日の回数で呼び出さない", async () => {
    await setOffHoursCall({ enabled: true, perDay: 1 });
    await seedTask(TASK, "勤怠の表を作る");
    await seedTask(NEXT, "記録の画面を作る");
    headers = await gate.signIn();
    await say("1 つ目");
    await gate.staff.builder.book.checkpoint({ kind: "pr", nodeId: TASK }, clock.now() + 60_000);
    clock.advance(10 * 60_000);
    headers = await gate.signIn();
    // 上限の日も 201 で、タスクは todo に戻す
    expect((await say("2 つ目")).status).toBe(201);
    expect((await gate.staff.builder.book.status(clock.now())).state).toBe("off");
    expect(await nodeStatus(NEXT)).toBe("todo");
  });

  it("呼び出しが落ちても 201 を返し、エラーログに残してタスクを戻す", async () => {
    await setOffHoursCall({ enabled: true, perDay: 2 });
    await seedTask(TASK, "勤怠の表を作る");
    gate.staff.builder.book.call = () => Promise.reject(new Error("StaffDO に届かない"));
    headers = await gate.signIn();
    expect((await say("今夜のうちに見て")).status).toBe(201);
    expect(await nodeStatus(TASK)).toBe("todo");
    const { results } = await d1.REC_2026.prepare("SELECT code FROM error_events").all();
    expect(results).toEqual([{ code: "message_call_failed" }]);
  });
});
