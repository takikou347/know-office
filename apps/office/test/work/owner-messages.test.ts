// オーナーの発言を社員に渡す。タスク中は今の呼び出しに足し、タスクの外は次の呼び出しの頭に足し、渡した印を 1 発言 1 行で残す (社員が考えるの 3.9)
import { type StaffId } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appendMessage } from "../../src/gate/routes/messages.ts";
import { markDelivered } from "../../src/gate/work/deliver.ts";
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
const DAY_MS = 24 * 60 * 60 * 1000;
const TASK = "019a7b00-0000-7000-8000-0000000000a1";
const NEXT = "019a7b00-0000-7000-8000-0000000000a2";

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

const Listed = z.object({ id: z.string(), body: z.string(), sender: z.string(), deliveredAt: z.string().nullable(), delivery: z.enum(["run", "next_task", "skipped"]).nullable() }).loose();
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
 * 開発担当を出勤させる
 * @param now 時刻
 */
async function clockIn(now = clock.now()): Promise<void> {
  await gate.staff.builder.book.wake(now - 2 * 60 * 60 * 1000);
  await gate.staff.builder.book.wake(now - 60 * 60 * 1000);
  await gate.staff.builder.book.heartbeat(now);
}

/**
 * 開発担当に次のタスクを取らせ、最初の呼び出しを始めさせる
 * @returns 始めた結果と、ワークスペースが受けた最後の指示
 */
async function takeAndStart(): Promise<{ result: string; prompt: string }> {
  await gate.env.STAFF.get(gate.env.STAFF.idFromName("builder")).pull(clock.now());
  const result = await startRun(gate.env, "builder", clock.now());
  return { result, prompt: RunCall.parse(gate.workspaces.builder.runs.at(-1)).prompt };
}

/**
 * オーナーが話しかける
 * @param body 本文
 * @returns 返事のステータスと data
 */
async function say(body: string): Promise<{ status: number; data: z.infer<typeof Listed> }> {
  const res = await gate.request("/api/v1/staff/builder/messages", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
  const json: unknown = await res.json();
  return { status: res.status, data: z.object({ data: Listed }).loose().parse(json).data };
}

/**
 * 会話を新しい順に読む
 * @returns メッセージ
 */
async function listed(): Promise<z.infer<typeof Listed>[]> {
  const res = await gate.request("/api/v1/staff/builder/messages", { headers });
  return z.object({ data: z.array(Listed) }).loose().parse(await res.json()).data;
}

/**
 * 渡した印の行を読む
 * @returns 行
 */
async function marks(): Promise<{ message_id: string; node_id: string | null; via: string }[]> {
  return (await d1.DB.prepare("SELECT message_id, node_id, via FROM message_deliveries ORDER BY message_id").all<{ message_id: string; node_id: string | null; via: string }>()).results;
}

/**
 * 記録の D1 にオーナーの発言を直に置く
 * @param id メッセージ ID
 * @param when 時刻
 * @param body 本文
 * @param sender 発言した側
 * @param db 記録の D1
 */
async function seedMessage(id: string, when: number, body: string, sender: "owner" | "staff" = "owner", db = d1.REC_2026): Promise<void> {
  await db.prepare("INSERT INTO messages (id, at, staff_id, node_id, sender, body, body_key) VALUES (?, ?, 'builder', NULL, ?, ?, NULL)").bind(id, when, sender, body).run();
}

/**
 * メッセージ ID を番号から作る。番号が大きいほど新しい
 * @param n 番号
 * @returns UUID v7 の形の ID
 */
function messageId(n: number): string {
  return `019a7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * ワークスペースの代わりの 1 つのメソッドを包む
 * @param staffId 社員 ID
 * @param key 包むメソッド
 * @param hook 元のメソッドを受けて、包んだメソッドを返す
 */
function hookWorkspace(staffId: StaffId, key: "run" | "message", hook: (original: (input: unknown) => Promise<unknown>) => (input: unknown) => Promise<unknown>): void {
  const space = gate.env.WORKSPACE;
  gate.env.WORKSPACE = wrap(space, "get", (id: Parameters<typeof space.get>[0]) => {
    const stub = space.get(id);
    if (space.idFromName(staffId).toString() !== id.toString()) return stub;
    return wrap(stub, key, hook((input) => stub[key](input)));
  });
}

/**
 * バインディングの 1 つのメソッドだけを差し替えた物を作る。ほかのメソッドは元の物に回す
 * @param target 元のバインディング
 * @param key 差し替えるメソッド
 * @param replaced 差し替えた後のメソッド
 * @returns 包んだバインディング
 */
function wrap<T extends object>(target: T, key: string, replaced: unknown): T {
  return new Proxy(target, {
    get: (t, k) => {
      if (k === key) return replaced;
      const value: unknown = Reflect.get(t, k, t);
      const bound: unknown = typeof value === "function" ? value.bind(t) : value;
      return bound;
    },
  });
}

describe("オーナーの発言を渡す", () => {
  it("タスク中に話しかける", async () => {
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    await takeAndStart();
    clock.advance(60_000);
    const sent = await say("テストも足して");
    expect(sent.status).toBe(201);
    expect(sent.data).toMatchObject({ delivery: "run", deliveredAt: new Date(clock.now()).toISOString() });
    // 今の呼び出しに、本文とゲートウェイが受けた時刻を渡す
    expect(gate.workspaces.builder.messages).toEqual([{ body: "テストも足して", at: new Date(clock.now()).toISOString() }]);
    expect(await marks()).toEqual([{ message_id: sent.data.id, node_id: TASK, via: "run" }]);
    expect((await listed())[0]).toMatchObject({ id: sent.data.id, delivery: "run", deliveredAt: new Date(clock.now()).toISOString() });
    expect(gate.live.published).toContainEqual({ type: "message_delivered", delivery: { id: sent.data.id, via: "run", at: new Date(clock.now()).toISOString(), taskId: null } });
  });

  it("タスクの外で話しかけて次のタスクで渡す", async () => {
    const sent = await say("次は記録の画面を先に");
    expect(sent.data).toMatchObject({ delivery: null, deliveredAt: null });
    expect(gate.workspaces.builder.messages).toBeUndefined();
    expect((await listed())[0]).toMatchObject({ delivery: null, deliveredAt: null });
    clock.advance(60 * 60 * 1000);
    headers = await gate.signIn();
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const { result, prompt } = await takeAndStart();
    expect(result).toBe("started");
    // タスクの指示の後ろに、日本時間の時刻と JSON の文字列の本文で足す
    expect(prompt).toContain('オーナーの発言 (日本時間 2026-12-01 10:00): "次は記録の画面を先に"');
    expect(prompt.indexOf("勤怠の表を作る")).toBeLessThan(prompt.indexOf("次は記録の画面を先に"));
    expect(await marks()).toEqual([{ message_id: sent.data.id, node_id: TASK, via: "next_task" }]);
    expect((await listed())[0]).toMatchObject({ delivery: "next_task", deliveredAt: new Date(clock.now()).toISOString() });
    expect(gate.live.published).toContainEqual({ type: "message_delivered", delivery: { id: sent.data.id, via: "next_task", at: new Date(clock.now()).toISOString(), taskId: null } });
  });

  it("渡す途中でワークスペースが断る", async () => {
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    await takeAndStart();
    // 走っていない (409) 時と、届かない時
    gate.workspaces.builder.messageAnswer = "idle";
    const idle = await say("聞こえる?");
    gate.workspaces.builder.messageAnswer = "down";
    const down = await say("もう一度");
    expect([idle.status, down.status]).toEqual([201, 201]);
    expect([idle.data.delivery, down.data.delivery]).toEqual([null, null]);
    expect(await marks()).toEqual([]);
    const codes = (await d1.REC_2026.prepare("SELECT code FROM error_events").all<{ code: string }>()).results.map((r) => r.code);
    expect(codes).toEqual(["message_deliver_failed"]);
    // 渡せなかった発言は、次の呼び出しの頭で渡す
    delete gate.workspaces.builder.messageAnswer;
    const { prompt } = await takeAndStart();
    expect(prompt).toContain('"聞こえる?"');
    expect(prompt).toContain('"もう一度"');
    expect((await marks()).map((m) => m.via)).toEqual(["next_task", "next_task"]);
  });
});

describe("オーナーの発言を渡す境目", () => {
  it("24 時間ちょうどの発言は次の呼び出しで渡し、1 ms 過ぎた発言は渡さず「渡していません」にする", async () => {
    await seedMessage(messageId(1), at(10) - DAY_MS - 1, "古すぎる");
    await seedMessage(messageId(2), at(10) - DAY_MS, "ちょうど 24 時間前");
    expect((await listed()).map((m) => [m.body, m.delivery])).toEqual([
      ["ちょうど 24 時間前", null],
      ["古すぎる", "skipped"],
    ]);
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const { prompt } = await takeAndStart();
    expect(prompt).toContain("ちょうど 24 時間前");
    expect(prompt).not.toContain("古すぎる");
    // 24 時間の外は印を書かず、時刻から導く
    expect(await marks()).toEqual([{ message_id: messageId(2), node_id: TASK, via: "next_task" }]);
  });

  it("新しい 10 件を古い順に渡し、11 件目は skipped の印を付けて今の呼び出しにも渡さない", async () => {
    for (let n = 1; n <= 11; n += 1) await seedMessage(messageId(n), at(9, n), `発言${String(n)}番`);
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const { prompt } = await takeAndStart();
    const order = Array.from({ length: 10 }, (_, i) => prompt.indexOf(`"発言${String(i + 2)}番"`));
    expect(order.every((p, i) => p > 0 && (i === 0 || p > (order[i - 1] ?? 0)))).toBe(true);
    expect(prompt).not.toContain('"発言1番"');
    expect((await marks()).find((m) => m.message_id === messageId(1))?.via).toBe("skipped");
    expect(gate.workspaces.builder.messages).toBeUndefined();
    expect((await listed()).at(-1)).toMatchObject({ body: "発言1番", delivery: "skipped", deliveredAt: null });
  });

  it("本文は D1 の頭の 2,000 字だけを渡し、R2 に置いた長い発言には続きの在りかを書き添える", async () => {
    const exact = "😀".repeat(2000);
    await say(exact);
    clock.advance(1000);
    await say(`${"あ".repeat(2000)}い`);
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const { prompt } = await takeAndStart();
    expect(prompt).toContain(`${JSON.stringify(exact)}\n`);
    expect(prompt).toContain(`${JSON.stringify("あ".repeat(2000))} (頭の 2,000 字まで。続きは会話の画面にある)`);
    expect(prompt).not.toContain("あい");
  });

  it("社員の発言は渡さず、印も付けない", async () => {
    await appendMessage(gate.env, { staffId: "builder", sender: "staff", body: "勤怠の表を作り始めた", nodeId: null, traceId: null }, clock);
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const { prompt } = await takeAndStart();
    expect(prompt).not.toContain("勤怠の表を作り始めた");
    expect(await marks()).toEqual([]);
    expect((await listed())[0]).toMatchObject({ sender: "staff", delivery: null, deliveredAt: null });
  });

  it("24 時間前が前の年なら、前の年の記録の発言も渡す", async () => {
    const newYear = Date.UTC(2027, 0, 1, 10 - 9);
    clock.advance(newYear - clock.now());
    headers = await gate.signIn();
    await seedMessage(messageId(1), Date.UTC(2026, 11, 31, 20 - 9), "年末の話");
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const { prompt } = await takeAndStart();
    expect(prompt).toContain('オーナーの発言 (日本時間 2026-12-31 20:00): "年末の話"');
  });
});

describe("オーナーの発言を二重に渡さない", () => {
  it("今の呼び出しに渡した発言は、次の呼び出しの頭に足さない", async () => {
    await seedTask(TASK, "勤怠の表を作る");
    await seedTask(NEXT, "記録の画面を作る");
    await clockIn();
    await takeAndStart();
    await say("テストも足して");
    await gate.staff.builder.book.finish("done", clock.now());
    await d1.DB.prepare("UPDATE nodes SET status = 'done' WHERE id = ?").bind(TASK).run();
    const { prompt } = await takeAndStart();
    expect(prompt).toContain("記録の画面を作る");
    expect(prompt).not.toContain("テストも足して");
  });

  it("発言を足す時と呼び出しを始める時が同じ発言を同時に印しても、行は 1 つで配るのも 1 回", async () => {
    await seedMessage(messageId(1), at(9), "テストも足して");
    const db = gate.env.DB;
    let first = true;
    // 片方のバッチが書く直前に、もう片方の印を挟む
    gate.env.DB = wrap(db, "batch", async (statements: Parameters<typeof db.batch>[0]) => {
      if (first) {
        first = false;
        await markDelivered(gate.env, { staffId: "builder", nodeId: TASK }, [{ id: messageId(1), via: "run" }], clock.now());
      }
      return db.batch(statements);
    });
    const added = await markDelivered(gate.env, { staffId: "builder", nodeId: TASK }, [{ id: messageId(1), via: "next_task" }], clock.now());
    expect(added).toEqual([]);
    expect(await marks()).toEqual([{ message_id: messageId(1), node_id: TASK, via: "run" }]);
    expect(gate.live.published.filter((e) => z.object({ type: z.literal("message_delivered") }).loose().safeParse(e).success)).toHaveLength(1);
  });
});

describe("オーナーの発言を渡す途中で落ちる", () => {
  it("印を書けなくても呼び出しは始め、エラーログに残し、次の呼び出しでもう一度渡す", async () => {
    await seedMessage(messageId(1), at(9), "テストも足して");
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const db = gate.env.DB;
    gate.env.DB = wrap(db, "prepare", (sql: string) => {
      if (sql.startsWith("INSERT INTO message_deliveries")) throw new Error("D1 down");
      return db.prepare(sql);
    });
    const { result, prompt } = await takeAndStart();
    expect(result).toBe("started");
    expect(prompt).toContain("テストも足して");
    expect((await gate.env.STAFF.get(gate.env.STAFF.idFromName("builder")).runState(TASK)).started).toBe(true);
    const codes = (await d1.REC_2026.prepare("SELECT code FROM error_events").all<{ code: string }>()).results.map((r) => r.code);
    expect(codes).toContain("message_mark_failed");
    gate.env.DB = db;
    expect((await takeAndStart()).prompt).toContain("テストも足して");
  });

  it("読んだ後、呼び出しを頼むまでに届いた発言は、始めた後に今の呼び出しへ渡す", async () => {
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    const order: string[] = [];
    hookWorkspace("builder", "run", (original) => async (input) => {
      // 読み終えた後、ワークスペースに頼む間に届いた発言。始めた時刻より後で、ワークスペースはまだ走っていないので 409 で断っている
      clock.advance(1000);
      await seedMessage(messageId(1), clock.now(), "間に届いた");
      return original(input);
    });
    hookWorkspace("builder", "message", (original) => async (input) => {
      const { started } = await gate.env.STAFF.get(gate.env.STAFF.idFromName("builder")).runState(TASK);
      order.push(started ? "message_after_started" : "message_before_started");
      return original(input);
    });
    const { prompt } = await takeAndStart();
    expect(prompt).not.toContain("間に届いた");
    expect(order).toEqual(["message_after_started"]);
    expect(gate.workspaces.builder.messages).toEqual([{ body: "間に届いた", at: new Date(clock.now()).toISOString() }]);
    expect(await marks()).toEqual([{ message_id: messageId(1), node_id: TASK, via: "run" }]);
  });

  it("発言を足した後に渡す所で投げても、201 を返して発言を残す", async () => {
    await seedTask(TASK, "勤怠の表を作る");
    await clockIn();
    await takeAndStart();
    hookWorkspace("builder", "message", () => () => Promise.reject(new Error("壊れた")));
    const sent = await say("聞こえる?");
    expect(sent.status).toBe(201);
    expect((await listed())[0]).toMatchObject({ body: "聞こえる?", delivery: null });
  });
});
