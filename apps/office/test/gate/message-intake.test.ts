// 社長への発言から社長が分けるタスクを足す。走っている社長には今の呼び出しに渡し、ほかの時は受け付けのプロジェクトの下に足して印 task を付ける (タスクとレビューの 3.1 の 7、社員が考えるの 3.9)
import type { StaffId } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appendMessage } from "../../src/gate/routes/messages.ts";
import { intakeMessage } from "../../src/gate/work/loop.ts";
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
const DAY = "2026-12-01";
const TASK = "019a7b00-0000-7000-8000-0000000000a1";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  clock = fixedClock(at(10));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const Sent = z.object({ id: z.string(), delivery: z.string().nullable(), deliveredAt: z.string().nullable(), taskId: z.string().nullable(), orders: z.array(z.unknown()) }).loose();
const RunCall = z.object({ prompt: z.string() }).loose();

/**
 * オーナーが話しかける
 * @param body 本文
 * @param staffId 社員 ID
 * @returns 返事のステータスと data
 */
async function say(body: string, staffId: StaffId = "president"): Promise<{ status: number; data: z.infer<typeof Sent> }> {
  const res = await gate.request(`/api/v1/staff/${staffId}/messages`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
  const json: unknown = await res.json();
  return { status: res.status, data: res.ok ? z.object({ data: Sent }).loose().parse(json).data : Sent.parse({ id: "", delivery: null, deliveredAt: null, taskId: null, orders: [] }) };
}

/**
 * 行を読む
 * @param query SQL
 * @param args バインドする値
 * @returns 行
 */
async function rows(query: string, ...args: unknown[]): Promise<Record<string, unknown>[]> {
  return (await d1.DB.prepare(query).bind(...args).all()).results;
}

/**
 * 社長の分けるタスクを読む
 * @returns 題、元、状態
 */
function plans(): Promise<Record<string, unknown>[]> {
  return rows("SELECT id, title, source, status FROM nodes WHERE kind = 'task' AND assignee = 'president' AND task_kind = 'plan' ORDER BY id");
}

/**
 * 社員のタスクを todo で置く
 * @param staffId 社員 ID
 */
async function seedTask(staffId: StaffId): Promise<void> {
  await d1.DB.prepare(
    "INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', '勤怠の表を作る', '本文', 'todo', 1, ?, 'build', NULL, 'owner', 0, 0)",
  )
    .bind(TASK, staffId)
    .run();
}

/**
 * 社員を出勤させる
 * @param staffId 社員 ID
 */
async function clockIn(staffId: StaffId): Promise<void> {
  const now = clock.now();
  await gate.staff[staffId].book.wake(now - 2 * 60 * 60 * 1000);
  await gate.staff[staffId].book.wake(now - 60 * 60 * 1000);
  await gate.staff[staffId].book.heartbeat(now);
}

/**
 * 社員にタスクを取らせ、最初の呼び出しを始めさせる
 * @param staffId 社員 ID
 */
async function takeAndStart(staffId: StaffId): Promise<void> {
  await seedTask(staffId);
  await clockIn(staffId);
  await gate.env.STAFF.get(gate.env.STAFF.idFromName(staffId)).pull(clock.now());
  expect(await startRun(gate.env, staffId, clock.now())).toBe("started");
}

/**
 * 会話の言葉の指示を開く
 */
async function openChatOrders(): Promise<void> {
  await d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES ('019a7b00-0000-7000-8000-00000000fff1', 'workday.chatOrders', 'office', ?, 1, 'owner', 'テスト', 0)")
    .bind(JSON.stringify({ enabled: true, perDay: 20 }))
    .run();
}

/**
 * D1 の batch を包む
 * @param hook 元の batch を受けて、包んだ batch を返す
 */
function hookBatch(hook: (original: D1Batch) => D1Batch): void {
  const db = gate.env.DB;
  const original: D1Batch = (statements) => db.batch(statements);
  gate.env.DB = new Proxy(db, {
    get: (t, k) => {
      if (k === "batch") return hook(original);
      const value: unknown = Reflect.get(t, k, t);
      const bound: unknown = typeof value === "function" ? value.bind(t) : value;
      return bound;
    },
  });
}
type D1Batch = TestGate["env"]["DB"]["batch"];

describe("目的からタスクまでの木", () => {
  it("同じ発言を 2 度タスクにしない", async () => {
    const message = await appendMessage(gate.env, { staffId: "president", sender: "owner", body: "勤怠を週ごとにも見たい", nodeId: null, traceId: null }, clock);
    const pending = { id: message.id, at: clock.now(), body: message.body };
    // 同時に 2 回足しても、タスクは 1 つ、印は 1 行
    const both = await Promise.all([intakeMessage(gate.env, pending, clock.now()), intakeMessage(gate.env, pending, clock.now())]);
    expect(both.filter((id) => id !== null)).toHaveLength(1);
    expect((await plans()).map((p) => p["source"])).toEqual([`chat:${message.id}`]);
    expect(await rows("SELECT message_id, via FROM message_deliveries")).toEqual([{ message_id: message.id, via: "task" }]);
    expect((await d1.REC_2026.prepare("SELECT COUNT(*) AS n FROM node_events WHERE kind = 'created' AND node_id = ?").bind(both.find((id) => id !== null)).all()).results).toEqual([{ n: 1 }]);

    // 社長の呼び出しの頭で先に渡った発言は、タスクにしない
    const later = await appendMessage(gate.env, { staffId: "president", sender: "owner", body: "記録も見たい", nodeId: null, traceId: null }, clock);
    hookBatch((original) => async (statements) => {
      await gate.env.DB.prepare("INSERT INTO message_deliveries (message_id, staff_id, node_id, via, delivered_at) VALUES (?, 'president', NULL, 'next_task', ?)").bind(later.id, clock.now()).run();
      return original(statements);
    });
    expect(await intakeMessage(gate.env, { id: later.id, at: clock.now(), body: later.body }, clock.now())).toBeNull();
    expect(await plans()).toHaveLength(1);
    expect(await rows("SELECT via FROM message_deliveries WHERE message_id = ?", later.id)).toEqual([{ via: "next_task" }]);
  });

  it("指示と頼みが混ざった発言", async () => {
    await openChatOrders();
    gate.claude.push({ content: [{ type: "tool_use", id: "toolu_fake", name: "record_orders", input: { orders: [{ kind: "off", day: DAY }] } }], stop_reason: "tool_use" }, { forGate: true });
    const body = "今日は休みにして。あと README の誤字も直して";
    const sent = await say(body);
    expect(sent.status).toBe(201);
    // 休みの指示を足し、頼みを落とさないよう全文をタスクにもする
    expect(sent.data.orders).toHaveLength(1);
    expect(await rows("SELECT kind, day, source FROM day_orders")).toEqual([{ kind: "off", day: DAY, source: "chat" }]);
    expect(sent.data.delivery).toBe("task");
    expect(sent.data.taskId).not.toBeNull();
    expect(String((await rows("SELECT body FROM nodes WHERE id = ?", sent.data.taskId))[0]?.["body"])).toContain(body);
  });

  it("タスクにできなくても発言は残る", async () => {
    hookBatch(() => () => Promise.reject(new Error("D1 が落ちた")));
    const sent = await say("勤怠を週ごとにも見たい");
    expect(sent.status).toBe(201);
    expect(sent.data).toMatchObject({ delivery: null, taskId: null });
    expect(await plans()).toEqual([]);
    expect((await d1.REC_2026.prepare("SELECT code FROM error_events").all()).results).toEqual([{ code: "message_intake_failed" }]);
    // 印が無いので、社長の次の呼び出しの頭で渡す
    gate.env.DB = d1.DB;
    await takeAndStart("president");
    expect(RunCall.parse(gate.workspaces.president.runs.at(-1)).prompt).toContain("勤怠を週ごとにも見たい");
    expect(await rows("SELECT message_id, via FROM message_deliveries")).toEqual([{ message_id: sent.data.id, via: "next_task" }]);
  });

  it("走っている社長への話しかけはタスクにしない", async () => {
    await takeAndStart("president");
    clock.advance(60_000);
    const sent = await say("その分け方で進めて");
    // 今の呼び出しにだけ渡し、操縦を残す
    expect(sent.data).toMatchObject({ delivery: "run", taskId: null });
    expect(gate.workspaces.president.messages).toEqual([{ body: "その分け方で進めて", at: new Date(clock.now()).toISOString() }]);
    expect(await plans()).toEqual([]);
  });
});

describe("会話と配信", () => {
  it("出勤して手の空いた社長への発言はタスクにし、すぐ取る", async () => {
    await clockIn("president");
    expect(await gate.staff.president.book.status(clock.now())).toMatchObject({ state: "working", nodeId: null });
    const sent = await say("勤怠を週ごとにも見たい");
    expect(sent.data.delivery).toBe("task");
    expect(sent.data.taskId).not.toBeNull();
    expect(gate.workspaces.president.messages).toBeUndefined();
    expect(await gate.staff.president.book.status(clock.now())).toMatchObject({ nodeId: sent.data.taskId });
  });

  it("社長でない社員への発言はタスクにしない", async () => {
    const sent = await say("次は記録の画面を先に", "builder");
    expect(sent.data).toMatchObject({ delivery: null, taskId: null });
    expect(await rows("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 0 }]);
  });

  it("止めた社長は 409 で、タスクも印も足さない", async () => {
    await gate.staff.president.book.wake(at(9));
    await gate.staff.president.book.stop(at(10));
    expect((await say("分けて")).status).toBe(409);
    expect(await plans()).toEqual([]);
    expect(await rows("SELECT COUNT(*) AS n FROM message_deliveries")).toEqual([{ n: 0 }]);
  });

  it("タスクにした印を足したタスクと一緒に配る", async () => {
    const sent = await say("勤怠を週ごとにも見たい");
    expect(gate.live.published).toContainEqual({ type: "message_delivered", delivery: { id: sent.data.id, via: "task", at: new Date(clock.now()).toISOString(), taskId: sent.data.taskId } });
    // 監査ログに足した物を残す
    expect(gate.audits.filter((a) => a.action === "node.create" && a.target === sent.data.taskId)).toHaveLength(1);
    // 本文は発言の全文で、渡した印は足したタスクを指し、会話の一覧も同じ
    expect(String((await rows("SELECT body FROM nodes WHERE id = ?", sent.data.taskId))[0]?.["body"])).toContain("勤怠を週ごとにも見たい");
    expect(await rows("SELECT message_id, node_id, via FROM message_deliveries")).toEqual([{ message_id: sent.data.id, node_id: sent.data.taskId, via: "task" }]);
    const listed = z.object({ data: z.array(Sent) }).loose().parse(await (await gate.request("/api/v1/staff/president/messages", { headers })).json()).data;
    expect(listed[0]).toMatchObject({ id: sent.data.id, delivery: "task", taskId: sent.data.taskId });
  });
});
