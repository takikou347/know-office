// オーナーの発言から勤務の指示を Haiku で抜き出して足す。設定で閉じて入れ、1 日の回数で止め、延長はパスキーで確かめる (社員と勤怠の 3.4)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
const MINUTE = 60_000;

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

const Order = z.object({ id: z.string(), kind: z.string(), day: z.string(), until: z.string().nullable(), cancelledAt: z.string().nullable() }).strict();
const Skipped = z.object({ kind: z.literal("extend"), day: z.string(), until: z.string(), skipped: z.literal("step_up_required") }).strict();
const Sent = z.object({ id: z.string(), orders: z.array(z.union([Order, Skipped])) }).loose();
const Request = z.object({ model: z.string(), max_tokens: z.number(), system: z.string(), tool_choice: z.unknown(), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).loose();

/**
 * 設定を置く
 * @param key 設定のキー
 * @param value 値
 */
async function setSwitch(key: "workday.chatOrders" | "workday.offHoursCall", value: unknown): Promise<void> {
  await d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, ?, 'office', ?, 1, 'owner', 'テスト', 0)")
    .bind(key === "workday.chatOrders" ? "019a7b00-0000-7000-8000-00000000fff1" : "019a7b00-0000-7000-8000-00000000fff2", key, JSON.stringify(value))
    .run();
}

/**
 * 代わりの Claude API に、ゲートウェイの抜き出しへの返事を積む
 * @param orders tool の入力の orders
 * @param extra 返事に足す物
 */
function answer(orders: unknown, extra: { stop_reason?: string } = {}): void {
  gate.claude.push({ content: [{ type: "tool_use", id: "toolu_fake", name: "record_orders", input: { orders } }], stop_reason: extra.stop_reason ?? "tool_use", usage: { input_tokens: 400, output_tokens: 40 } }, { forGate: true });
}

/**
 * オーナーがレビュー担当に話しかける
 * @param body 本文
 * @returns 返事のステータスと data
 */
async function say(body: string): Promise<{ status: number; data: z.infer<typeof Sent> }> {
  const res = await gate.request("/api/v1/staff/reviewer/messages", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
  return { status: res.status, data: z.object({ data: Sent }).loose().parse(await res.json()).data };
}

/**
 * D1 の行を読む
 * @param db D1
 * @param query SQL
 * @returns 行
 */
async function rows(db: TestD1["DB"], query: string): Promise<Record<string, unknown>[]> {
  return (await db.prepare(query).all()).results;
}

/**
 * パスキーで確かめた事にする
 * @param until 確かめが切れる時刻
 */
async function stepUpUntil(until: number): Promise<void> {
  await d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(until).run();
}

describe("オーナーの指示に合わせる", () => {
  it("会話の言葉で休みにする", async () => {
    await setSwitch("workday.chatOrders", { enabled: true, perDay: 20 });
    answer([{ kind: "off", day: DAY }]);
    const sent = await say("今日は休みにして");
    expect(sent.status).toBe(201);
    const [order] = sent.data.orders;
    const id = Order.parse(order).id;
    expect(sent.data.orders).toEqual([{ id, kind: "off", day: DAY, until: null, cancelledAt: null }]);
    expect(await rows(d1.DB, "SELECT staff_id, day, kind, source, message_id FROM day_orders")).toEqual([{ staff_id: "reviewer", day: DAY, kind: "off", source: "chat", message_id: sent.data.id }]);
    expect(gate.audits.filter((a) => a.action === "order.create").map((a) => a.detail)).toEqual([{ staffId: "reviewer", day: DAY, kind: "off", source: "chat" }]);
    // 社員 DO の予定も休みになる
    expect((await gate.staff.reviewer.book.status(clock.now())).state).toBe("off");
    // Haiku を 1 回、決めた形で呼ぶ
    const [req] = gate.claude.requests.map((r) => Request.parse(r));
    expect(req).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 300, tool_choice: { type: "tool", name: "record_orders" }, messages: [{ role: "user", content: '"今日は休みにして"' }] });
    expect(req?.system).toContain(`今日: ${DAY}`);
    expect(req?.system).toContain("所定の勤務の終わり: 17:00");
    expect(req?.system).toContain("否定");
    expect(gate.claude.keys).toEqual(["test-anthropic-key-0123456789"]);
    expect(await rows(d1.REC_2026, "SELECT staff_id, scope, model, input_tokens, output_tokens, request_id FROM usage")).toEqual([
      { staff_id: "reviewer", scope: "office", model: "claude-haiku-5-5", input_tokens: 400, output_tokens: 40, request_id: `chat_orders:${sent.data.id}` },
    ]);
    // 会話の一覧にも付き、取り消すと取り消した時刻が付く
    const listed = async () => z.object({ data: z.array(Sent) }).loose().parse(await (await gate.request("/api/v1/staff/reviewer/messages", { headers })).json()).data;
    expect((await listed())[0]?.orders).toEqual(sent.data.orders);
    clock.advance(MINUTE);
    expect((await gate.request(`/api/v1/staff/reviewer/orders/${id}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await listed())[0]?.orders).toEqual([{ ...sent.data.orders[0], cancelledAt: new Date(clock.now()).toISOString() }]);
    // 取り消しの行はボタンの物で、元の発言を持たない
    expect(await rows(d1.DB, "SELECT source, message_id FROM day_orders WHERE cancels IS NOT NULL")).toEqual([{ source: "button", message_id: null }]);
  });

  it("会話の言葉の指示が閉じていれば抜き出さない", async () => {
    answer([{ kind: "off", day: DAY }]);
    expect((await say("今日は休みにして")).data.orders).toEqual([]);
    // 壊れた値も閉じているとみなす
    await setSwitch("workday.chatOrders", { enabled: "yes", perDay: 20 });
    expect((await say("今日は休みにして")).data.orders).toEqual([]);
    expect(gate.claude.requests).toEqual([]);
    expect(await rows(d1.DB, "SELECT id FROM day_orders")).toEqual([]);
    expect(await rows(d1.REC_2026, "SELECT id FROM usage")).toEqual([]);
  });

  it("会話の言葉の延長はパスキーで確かめる", async () => {
    await setSwitch("workday.chatOrders", { enabled: true, perDay: 20 });
    // 確かめていないセッションでは足さず、返事にだけ印を付ける
    answer([{ kind: "extend", day: DAY, until: "19:00" }]);
    expect((await say("今日は 19 時まで延長して")).data.orders).toEqual([{ kind: "extend", day: DAY, until: "19:00", skipped: "step_up_required" }]);
    // 確かめがちょうど切れた時も足さない
    await stepUpUntil(clock.now());
    answer([{ kind: "extend", day: DAY, until: "19:00" }]);
    expect((await say("今日は 19 時まで延長して")).data.orders).toMatchObject([{ skipped: "step_up_required" }]);
    expect(await rows(d1.DB, "SELECT id FROM day_orders")).toEqual([]);
    // 15 分以内に確かめたセッションでは足す。休みと一緒でも別々に足す
    await stepUpUntil(clock.now() + 15 * MINUTE);
    answer([
      { kind: "extend", day: DAY, until: "19:00" },
      { kind: "off", day: "2026-12-02" },
    ]);
    expect((await say("今日は 19 時まで延長して、明日は休みにして")).data.orders).toMatchObject([
      { kind: "extend", day: DAY, until: "19:00", cancelledAt: null },
      { kind: "off", day: "2026-12-02", until: null },
    ]);
    expect(await rows(d1.DB, "SELECT kind, source FROM day_orders ORDER BY kind")).toEqual([
      { kind: "extend", source: "chat" },
      { kind: "off", source: "chat" },
    ]);
  });

  it("会話の言葉の 1 日の回数で抜き出さない", async () => {
    await setSwitch("workday.chatOrders", { enabled: true, perDay: 2 });
    for (let i = 0; i < 3; i += 1) answer([]);
    await say("1 つ目");
    await say("2 つ目");
    // 上限ちょうどの後は呼ばない
    await say("3 つ目");
    expect(gate.claude.requests).toHaveLength(2);
    // 社員をまたいで office 全体で数える
    const other = await gate.request("/api/v1/staff/builder/messages", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body: "4 つ目" }) });
    expect(other.status).toBe(201);
    expect(gate.claude.requests).toHaveLength(2);
    // 日本時間の 0 時で数え直す
    clock.advance(at(24) - clock.now());
    headers = await gate.signIn();
    await say("次の日");
    expect(gate.claude.requests).toHaveLength(3);
    // 印は追記だけで、消せない
    await expect(d1.DB.prepare("DELETE FROM chat_order_reads").run()).rejects.toThrow(/append only/);
  });

  it("会話の言葉の同時の 2 つで 1 日の回数を超えない", async () => {
    await setSwitch("workday.chatOrders", { enabled: true, perDay: 1 });
    answer([]);
    answer([]);
    const sent = await Promise.all([say("1 つ目"), say("2 つ目")]);
    expect(sent.map((s) => s.status)).toEqual([201, 201]);
    expect(gate.claude.requests).toHaveLength(1);
    expect(await rows(d1.DB, "SELECT COUNT(*) AS n FROM chat_order_reads")).toEqual([{ n: 1 }]);
  });

  it("会話の言葉の指示を抜き出せなくても発言は残る", async () => {
    await setSwitch("workday.chatOrders", { enabled: true, perDay: 20 });
    // 429 と 5xx は使った量を書かず、エラーログに残す
    gate.claude.pushError(429, "rate_limit_error");
    const limited = await say("今日は休みにして");
    expect(limited).toMatchObject({ status: 201, data: { orders: [] } });
    gate.claude.pushError(529, "overloaded_error");
    expect((await say("今日は休みにして")).data.orders).toEqual([]);
    expect(await rows(d1.REC_2026, "SELECT id FROM usage")).toEqual([]);
    expect(await rows(d1.REC_2026, "SELECT code FROM error_events")).toEqual([{ code: "chat_orders_failed" }, { code: "chat_orders_failed" }]);
    // 形の違う返事、長さで切れた返事、4 件以上の返事は 0 件。使った量は書く
    answer([{ kind: "off" }]);
    answer([{ kind: "off", day: DAY }], { stop_reason: "max_tokens" });
    answer([1, 2, 3, 4].map(() => ({ kind: "off", day: DAY })));
    // 過ぎた時刻の早退と、組の合わない物は足さない
    answer([
      { kind: "leave_early", day: DAY, until: "09:30" },
      { kind: "off", day: DAY, until: "12:00" },
    ]);
    for (const body of ["形違い", "切れた", "多すぎる", "過ぎた"]) expect((await say(body)).data.orders).toEqual([]);
    expect(await rows(d1.REC_2026, "SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 4 }]);
    // 同じ日の同じ指示は 2 つ目を足さない
    answer([{ kind: "leave_early", day: DAY, until: "15:00" }]);
    answer([{ kind: "leave_early", day: DAY, until: "16:00" }]);
    expect((await say("15 時で上がって")).data.orders).toHaveLength(1);
    expect((await say("16 時で上がって")).data.orders).toEqual([]);
    expect(await rows(d1.DB, "SELECT kind, until FROM day_orders")).toEqual([{ kind: "leave_early", until: at(15) }]);
  });

  it("会話の言葉で休みにした日は呼び出さない", async () => {
    clock.advance(at(21) - clock.now());
    await setSwitch("workday.chatOrders", { enabled: true, perDay: 20 });
    await setSwitch("workday.offHoursCall", { enabled: true, perDay: 2 });
    await d1.DB.prepare(
      "INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', 'レビューする', '本文', 'todo', 1, 'reviewer', 'review', NULL, 'president', 0, 0)",
    )
      .bind(TASK)
      .run();
    headers = await gate.signIn();
    answer([{ kind: "off", day: DAY }]);
    expect((await say("今日は休みにして")).data.orders).toMatchObject([{ kind: "off", day: DAY }]);
    expect((await gate.staff.reviewer.book.status(clock.now())).state).toBe("off");
    expect(await rows(d1.DB, `SELECT status FROM nodes WHERE id = '${TASK}'`)).toEqual([{ status: "todo" }]);
    // 明日の休みは今日の呼び出しを止めない
    answer([{ kind: "off", day: "2026-12-02" }]);
    await say("明日は休みにして");
    expect((await gate.staff.reviewer.book.status(clock.now())).state).toBe("called");
  });

  it("会話の言葉の指示を 90 件を超える発言の一覧にも付ける", async () => {
    const ids = Array.from({ length: 91 }, (_, i) => `019a7b00-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const stmts = ids.flatMap((id, i) => [
      d1.REC_2026.prepare("INSERT INTO messages (id, at, staff_id, node_id, sender, body, body_key, trace_id) VALUES (?, ?, 'reviewer', NULL, 'owner', '休みにして', NULL, NULL)").bind(id, clock.now() - i),
      d1.DB.prepare("INSERT INTO day_orders (id, staff_id, day, kind, until, source, cancels, created_at, message_id) VALUES (?, 'reviewer', ?, 'off', NULL, 'chat', NULL, 0, ?)").bind(`019a7b01-0000-7000-8000-${String(i).padStart(12, "0")}`, DAY, id),
    ]);
    for (const stmt of stmts) await stmt.run();
    const res = await gate.request("/api/v1/staff/reviewer/messages?limit=100", { headers });
    const listed = z.object({ data: z.array(Sent) }).loose().parse(await res.json()).data;
    expect(listed).toHaveLength(91);
    expect(listed.every((m) => m.orders.length === 1)).toBe(true);
  });
});
