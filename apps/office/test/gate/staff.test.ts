// 社員の一覧と、その日だけの指示のルート。指示は 1 文の条件付きで書き、同時の 2 つと二重の取り消しを 1 つにする (社員と勤怠の 3.4、API の staff)
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const MINUTE = 60_000;
const DAY = "2026-11-16";
/**
 * 2026-11-16 (日本時間) の時刻を返す
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
const at = (h: number, m = 0) => Date.UTC(2026, 10, 16, h - 9, m);

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

/** 今のログインセッションでパスキーを確かめた事にする */
async function stepUp(): Promise<void> {
  await d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(clock.now() + 15 * MINUTE).run();
}

const Order = z.object({ id: z.string(), kind: z.string(), until: z.string().nullable(), cancelledAt: z.string().nullable(), source: z.string(), day: z.string(), staffId: z.string() }).loose();
const OrderReply = z.object({ data: Order });
const OrderList = z.object({ data: z.array(Order) });

/**
 * 指示を出す
 * @param body 入力
 * @param staffId 社員 ID
 * @returns 返事
 */
function order(body: unknown, staffId = "builder") {
  return gate.request(`/api/v1/staff/${staffId}/orders`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * 指示を取り消す
 * @param id 指示 ID
 * @param staffId 社員 ID
 * @returns 返事
 */
function cancel(id: string, staffId = "builder") {
  return gate.request(`/api/v1/staff/${staffId}/orders/${id}`, { method: "DELETE", headers });
}

/**
 * その日の指示を読む
 * @param staffId 社員 ID
 * @returns 指示の並び
 */
async function orders(staffId = "builder") {
  const res = await gate.request(`/api/v1/staff/${staffId}/orders?day=${DAY}`, { headers });
  expect(res.status).toBe(200);
  return OrderList.parse(await res.json()).data;
}

describe("社員の一覧", () => {
  it("社員の一覧は 3 人の今の状態と役を返す", async () => {
    await gate.staff.builder.book.wake(at(9));
    const res = await gate.request("/api/v1/staff", { headers });
    expect(res.status).toBe(200);
    const body = z.object({ data: z.array(z.unknown()), meta: z.object({ next: z.null() }).loose() }).parse(await res.json());
    expect(body.data).toEqual([
      { id: "president", role: "社長", model: "claude-opus-5-5", state: "off", nodeId: null, nodeTitle: null, workedMsToday: 0 },
      expect.objectContaining({ id: "builder", role: "開発担当", state: "working", workedMsToday: 60 * MINUTE }),
      expect.objectContaining({ id: "reviewer", role: "レビュー担当", model: "claude-opus-5-5", state: "off" }),
    ]);
  });
});

describe("オーナーの指示に合わせる", () => {
  it("その日だけ休みにする", async () => {
    await gate.staff.builder.book.wake(at(9));
    await gate.staff.builder.book.heartbeat(at(10));
    const res = await order({ day: DAY, kind: "off" });
    expect(res.status).toBe(201);
    const made = OrderReply.parse(await res.json()).data;
    expect(made).toMatchObject({ staffId: "builder", day: DAY, kind: "off", until: null, source: "button", cancelledAt: null });
    expect(res.headers.get("Location")).toBe(`/api/v1/staff/builder/orders?day=${DAY}`);
    expect(await d1.DB.prepare("SELECT kind, until, source, cancels FROM day_orders").all().then((r) => r.results)).toEqual([{ kind: "off", until: null, source: "button", cancels: null }]);
    expect(gate.audits).toContainEqual(expect.objectContaining({ action: "order.create", target: made.id }));
    // 社員 DO が予定を作り直し、勤務中の休みはタスクを持っていなければすぐ退勤し、理由がオーナーの指示として残る
    expect((await gate.staff.builder.book.status(at(10))).state).toBe("off");
    expect(await d1.DB.prepare("SELECT reasons FROM daily_totals WHERE staff_id = 'builder'").first("reasons")).toContain("off:owner_instruction");
  });

  it("延長の指示はパスキー無しだと 401 step_up_required、休みと早退は通る", async () => {
    const res = await order({ day: DAY, kind: "extend", until: "18:30" });
    expect(res.status).toBe(401);
    expect(Problem.parse(await res.json()).code).toBe("step_up_required");
    expect((await order({ day: DAY, kind: "leave_early", until: "16:00" })).status).toBe(201);
    expect((await order({ day: DAY, kind: "off" })).status).toBe(201);
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM day_orders WHERE kind = 'extend'").first("n")).toBe(0);
  });

  it("延長の指示を出して取り消す", async () => {
    await stepUp();
    const made = OrderReply.parse(await (await order({ day: DAY, kind: "extend", until: "18:30" })).json()).data;
    expect(made.until).toBe("18:30");
    expect(await d1.DB.prepare("SELECT until FROM day_orders").first("until")).toBe(at(18, 30));
    clock.advance(MINUTE);
    const res = await cancel(made.id);
    expect(res.status).toBe(200);
    expect(OrderReply.parse(await res.json()).data).toMatchObject({ id: made.id, cancelledAt: new Date(at(10, 1)).toISOString() });
    expect(await orders()).toEqual([expect.objectContaining({ id: made.id, cancelledAt: new Date(at(10, 1)).toISOString() })]);
    expect(gate.audits).toContainEqual(expect.objectContaining({ action: "order.cancel", target: made.id }));
    // 取り消した後は同じ種類の指示をまた出せる
    expect((await order({ day: DAY, kind: "extend", until: "19:00" })).status).toBe(201);
  });

  it("同じ日の同じ指示を同時に 2 つ出しても 1 つだけ通る", async () => {
    await stepUp();
    const statuses = (await Promise.all([order({ day: DAY, kind: "extend", until: "18:00" }), order({ day: DAY, kind: "extend", until: "19:00" })])).map((r) => r.status);
    expect(statuses.toSorted((a, b) => a - b)).toEqual([201, 409]);
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM day_orders").first("n")).toBe(1);
  });

  it("取り消しを同時に 2 回送っても 1 回だけ通る", async () => {
    const made = OrderReply.parse(await (await order({ day: DAY, kind: "off" })).json()).data;
    const replies = await Promise.all([cancel(made.id), cancel(made.id)]);
    expect(replies.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    const conflict = replies.find((r) => r.status === 409);
    expect(Problem.parse(await conflict?.json()).code).toBe("conflict");
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM day_orders WHERE cancels IS NOT NULL").first("n")).toBe(1);
  });

  it("過ぎた時刻、今ちょうど、過ぎた日の指示は 409 で、1 分後は通る", async () => {
    clock.advance(6 * 60 * MINUTE);
    // ログインセッションは操作が 2 時間無いと切れるので、進めた後に作り直す
    headers = await gate.signIn();
    await stepUp();
    expect(Problem.parse(await (await order({ day: DAY, kind: "extend", until: "15:59" })).json()).code).toBe("conflict");
    expect((await order({ day: DAY, kind: "leave_early", until: "16:00" })).status).toBe(409);
    expect((await order({ day: "2026-11-15", kind: "off" })).status).toBe(409);
    expect((await order({ day: DAY, kind: "leave_early", until: "16:01" })).status).toBe(201);
  });

  it("until の無い延長、until のある休み、形の違う until と日は 422", async () => {
    await stepUp();
    expect((await order({ day: DAY, kind: "extend" })).status).toBe(422);
    expect((await order({ day: DAY, kind: "off", until: "18:00" })).status).toBe(422);
    for (const until of ["24:00", "9:05", "12:60", "", "09:00:00", "１８:００"]) expect((await order({ day: DAY, kind: "extend", until })).status).toBe(422);
    expect((await order({ day: "2026-02-30", kind: "off" })).status).toBe(422);
    expect((await order({ day: DAY, kind: "off" }, "owner")).status).toBe(422);
    expect((await cancel("not-a-uuid")).status).toBe(422);
    expect(await d1.DB.prepare("SELECT count(*) AS n FROM day_orders").first("n")).toBe(0);
  });

  it("延長は終わりの時刻より後、早退は前だけ通り、0 時をまたぐ延長は断る", async () => {
    await stepUp();
    // 初期の終わりの時刻は 17 時
    expect((await order({ day: DAY, kind: "extend", until: "17:00" })).status).toBe(409);
    expect((await order({ day: DAY, kind: "leave_early", until: "17:00" })).status).toBe(409);
    expect((await order({ day: DAY, kind: "extend", until: "00:30" })).status).toBe(409);
    expect((await order({ day: DAY, kind: "extend", until: "17:01" })).status).toBe(201);
    expect((await order({ day: DAY, kind: "leave_early", until: "16:59" })).status).toBe(201);
  });

  it("取り消した後に同じ種類を出し直せ、直列の 2 回目の取り消しは 409、取り消しの行は取り消せない", async () => {
    const made = OrderReply.parse(await (await order({ day: DAY, kind: "off" })).json()).data;
    expect((await cancel(made.id)).status).toBe(200);
    expect((await cancel(made.id)).status).toBe(409);
    const cancelId = await d1.DB.prepare("SELECT id FROM day_orders WHERE cancels IS NOT NULL").first<string>("id");
    expect((await cancel(cancelId ?? "")).status).toBe(404);
    clock.advance(1);
    expect((await order({ day: DAY, kind: "off" })).status).toBe(201);
    expect((await orders()).map((o) => o.cancelledAt === null)).toEqual([false, true]);
  });

  it("社員 DO が予定を作り直せなくても指示は残り、次に起きた時に拾う", async () => {
    await gate.staff.builder.book.wake(at(9));
    await gate.staff.builder.book.heartbeat(at(10));
    const book = gate.staff.builder.book;
    const original = book.order.bind(book);
    book.order = () => Promise.reject(new Error("社員 DO に届かない"));
    const res = await order({ day: DAY, kind: "off" });
    expect(res.status).toBe(201);
    book.order = original;
    expect((await book.status(at(10))).state).toBe("working");
    await book.wake(at(10, 1));
    expect((await book.status(at(10, 1))).state).toBe("off");
    expect(await d1.REC_2026.prepare("SELECT code FROM error_events").all().then((r) => r.results)).toEqual([{ code: "order_replan_failed" }]);
  });

  it("ほかの社員の指示は取り消せず、無い指示は 404", async () => {
    await stepUp();
    const made = OrderReply.parse(await (await order({ day: DAY, kind: "off" })).json()).data;
    expect((await cancel(made.id, "reviewer")).status).toBe(404);
    expect((await cancel("019a7b00-0000-7000-8000-00000000ffff")).status).toBe(404);
    expect(await orders("reviewer")).toEqual([]);
  });
});
