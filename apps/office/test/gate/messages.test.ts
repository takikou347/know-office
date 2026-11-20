// 社員とのメッセージのルート。オーナーの発言を記録に足し、長い本文は R2 に置き、配信 DO に渡す (社員と自動の 3.7、API の conversation)
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { appendMessage, messageKey } from "../../src/gate/routes/messages.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

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

const Message = z
  .object({ id: z.string(), at: z.string(), staffId: z.string(), nodeId: z.string().nullable(), sender: z.string(), body: z.string(), deliveredAt: z.string().nullable(), delivery: z.string().nullable(), orders: z.array(z.unknown()), taskId: z.string().nullable() })
  .strict();
const Page = z.object({ data: z.array(Message), meta: z.object({ next: z.string().nullable() }).loose() });

/**
 * 社員に送る
 * @param body 入力
 * @param staffId 社員 ID
 * @returns 返事
 */
function send(body: unknown, staffId = "builder") {
  return gate.request(`/api/v1/staff/${staffId}/messages`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * メッセージを読む
 * @param query クエリ
 * @param staffId 社員 ID
 * @returns 返事
 */
function read(query = "", staffId = "builder") {
  return gate.request(`/api/v1/staff/${staffId}/messages${query}`, { headers });
}

describe("会話と配信", () => {
  it("オーナーの発言を足し、新しい順に読める", async () => {
    const first = await send({ body: "勤怠は表で見たい" });
    expect(first.status).toBe(201);
    const made = z.object({ data: Message }).parse(await first.json()).data;
    expect(made).toMatchObject({ staffId: "builder", sender: "owner", nodeId: null, body: "勤怠は表で見たい", at: new Date(at(10)).toISOString() });
    expect(first.headers.get("Location")).toBe("/api/v1/staff/builder/messages");
    clock.advance(1000);
    await send({ body: "次は記録の画面", nodeId: "019a7b00-0000-7000-8000-0000000000c1" });
    await send({ body: "見る役への話" }, "reviewer");
    const page = Page.parse(await (await read("?limit=1")).json());
    expect(page.data.map((m) => m.body)).toEqual(["次は記録の画面"]);
    expect(page.data[0]?.nodeId).toBe("019a7b00-0000-7000-8000-0000000000c1");
    const rest = Page.parse(await (await read(`?limit=1&cursor=${page.meta.next ?? ""}`)).json());
    expect(rest.data.map((m) => m.body)).toEqual(["勤怠は表で見たい"]);
    expect(rest.meta.next).toBeNull();
    // 配信 DO に、足した発言を渡す
    // 配信の発言は渡した印を持たない。印は message_delivered で別に配る
    const { deliveredAt: _at, delivery: _via, orders: _orders, taskId: _task, ...shown } = made;
    expect(gate.live.published).toContainEqual({ type: "message", message: { ...shown, truncated: false } });
  });

  it("2,000 字ちょうどは D1、2,001 字は R2 に置き、読む時に戻す", async () => {
    const exact = "あ".repeat(2000);
    const long = `${"い".repeat(2000)}う`;
    await send({ body: exact });
    clock.advance(1000);
    const made = z.object({ data: Message }).parse(await (await send({ body: long })).json()).data;
    const rows = (await d1.REC_2026.prepare("SELECT id, length(body) AS n, body_key FROM messages ORDER BY id").all()).results;
    expect(rows).toEqual([expect.objectContaining({ n: 2000, body_key: null }), { id: made.id, n: 2000, body_key: `messages/builder/${made.id}.txt` }]);
    expect(await (await d1.FILES.get(`messages/builder/${made.id}.txt`))?.text()).toBe(long);
    const page = Page.parse(await (await read()).json());
    expect(page.data.map((m) => m.body)).toEqual([long, exact]);
  });

  it("止めた社員には 409 stopped を返し、何も足さない", async () => {
    await gate.staff.builder.book.wake(at(9));
    await gate.staff.builder.book.stop(at(10));
    const res = await send({ body: "動いてる？" });
    expect(res.status).toBe(409);
    expect(Problem.parse(await res.json()).code).toBe("stopped");
    expect(await d1.REC_2026.prepare("SELECT count(*) AS n FROM messages").first("n")).toBe(0);
    expect(gate.live.published).toEqual([]);
  });

  it("形の違うカーソルは 400、空の本文と 20,001 字は 422", async () => {
    expect((await read("?cursor=../x")).status).toBe(400);
    expect((await send({ body: "" })).status).toBe(422);
    expect((await send({ body: "あ".repeat(20_001) })).status).toBe(422);
  });

  it("年をまたいで前の年の記録も続けて読む", async () => {
    clock.advance(Date.UTC(2027, 0, 1, 1) - clock.now());
    headers = await gate.signIn();
    await d1.REC_2026.prepare("INSERT INTO messages (id, at, staff_id, node_id, sender, body, body_key) VALUES ('019a7b00-0000-7000-8000-0000000000e1', ?, 'builder', NULL, 'staff', '去年の話', NULL)")
      .bind(at(10))
      .run();
    await send({ body: "今年の話" });
    const page = Page.parse(await (await read()).json());
    expect(page.data.map((m) => m.body)).toEqual(["今年の話", "去年の話"]);
  });
});

describe("速さ", () => {
  it("発言が届く速さ", async () => {
    // 社員の発言は、記録に足したのと同じ処理の中で配信 DO に渡し、間をおいて読み直すのを待たない
    const message = await appendMessage(gate.env, { staffId: "builder", sender: "staff", body: "勤怠の表を作り始めた", nodeId: null, traceId: null }, clock);
    const { deliveredAt: _at, delivery: _via, orders: _orders, taskId: _task, ...shown } = message;
    expect(gate.live.published).toEqual([{ type: "message", message: { ...shown, truncated: false } }]);
    const page = Page.parse(await (await read()).json());
    expect(page.data.map((m) => [m.sender, m.body])).toEqual([["staff", "勤怠の表を作り始めた"]]);
  });
});

describe("会話の境目", () => {
  it("字数は絵文字も 1 字と数え、2,000 字ちょうどは D1、2,001 字は R2、20,000 字は受けて 20,001 字は 422", async () => {
    const exact = "😀".repeat(2000);
    await send({ body: exact });
    clock.advance(1);
    await send({ body: "😀".repeat(2001) });
    const rows = (await d1.REC_2026.prepare("SELECT body, body_key FROM messages ORDER BY id").all<{ body: string; body_key: string | null }>()).results;
    expect(rows.map((r) => [r.body === exact, r.body_key === null])).toEqual([
      [true, true],
      [true, false],
    ]);
    expect((await send({ body: "😀".repeat(20_000) })).status).toBe(201);
    expect((await send({ body: "😀".repeat(20_001) })).status).toBe(422);
  });

  it("R2 に置けなければ D1 にも足さず、配らない", async () => {
    // R2 はファイルで共有するので中を差し替えず、このテストの env の FILES だけを包む
    const files = gate.env.FILES;
    gate.env.FILES = wrap(files, "put", () => Promise.reject(new Error("R2 down")));
    expect((await send({ body: "あ".repeat(2001) })).status).toBe(500);
    expect(await d1.REC_2026.prepare("SELECT count(*) AS n FROM messages").first("n")).toBe(0);
    expect(gate.live.published).toEqual([]);
  });

  it("R2 に置いた後に D1 に足せなければ、置いた本文を消す", async () => {
    const rec = gate.env.REC_2026;
    if (!rec) throw new Error("REC_2026 が無い");
    // D1 はファイルで共有するので中を差し替えず、このテストの env の REC_2026 だけを包む
    gate.env.REC_2026 = wrap(rec, "prepare", (sql: string) => {
      if (sql.startsWith("INSERT INTO messages")) throw new Error("D1 down");
      return rec.prepare(sql);
    });
    expect((await send({ body: "あ".repeat(2001) })).status).toBe(500);
    expect((await d1.FILES.list({ prefix: "messages/" })).objects).toEqual([]);
    expect(gate.live.published).toEqual([]);
  });

  it("R2 に本文が無いか、鍵がその発言の物でなければ、その発言だけ本文を空にしてエラーログに残す", async () => {
    const id = "019a7b00-0000-7000-8000-0000000000e2";
    const insert = d1.REC_2026.prepare("INSERT INTO messages (id, at, staff_id, node_id, sender, body, body_key) VALUES (?, ?, 'builder', NULL, 'staff', '頭だけ', ?)");
    await d1.REC_2026.batch([insert.bind(id, at(9), messageKey("builder", id)), insert.bind("019a7b00-0000-7000-8000-0000000000e3", at(9), messageKey("reviewer", "019a7b00-0000-7000-8000-0000000000e3"))]);
    // 鍵の形が違う行は、R2 に物があっても読まない (ほかの社員の本文を指させない)
    await d1.FILES.put(messageKey("reviewer", "019a7b00-0000-7000-8000-0000000000e3"), "ほかの社員の本文");
    await send({ body: "ふつうの話" });
    const page = Page.parse(await (await read()).json());
    expect(page.data.map((m) => m.body)).toEqual(["ふつうの話", "", ""]);
    const codes = (await d1.REC_2026.prepare("SELECT code FROM error_events").all<{ code: string }>()).results.map((r) => r.code);
    expect(codes).toEqual(["message_body_missing", "message_body_missing"]);
  });

  it("同じミリ秒の 2 件も、無い行を指すカーソルも、重なりも抜けも無く読む", async () => {
    await send({ body: "一" });
    await send({ body: "二" });
    await send({ body: "三" });
    const first = Page.parse(await (await read("?limit=2")).json());
    const rest = Page.parse(await (await read(`?limit=2&cursor=${first.meta.next ?? ""}`)).json());
    expect([...first.data, ...rest.data].map((m) => m.body).toSorted()).toEqual(["一", "三", "二"].toSorted());
    expect(rest.meta.next).toBeNull();
    // 消えた行を指すカーソルでも、それより古い物を読む
    const ghost = "019a7b00-0000-7fff-bfff-ffffffffffff";
    const after = Page.parse(await (await read(`?cursor=${ghost}`)).json());
    expect(after.data).toEqual([]);
    const all = Page.parse(await (await read("?cursor=ffffffff-ffff-7fff-bfff-ffffffffffff")).json());
    expect(all.data).toHaveLength(3);
  });

  it("止めるのと同時に送っても、通った数と足した数が合う", async () => {
    await gate.staff.builder.book.wake(at(9));
    const [res] = await Promise.all([send({ body: "今いる？" }), gate.staff.builder.book.stop(at(10))]);
    const rows = await d1.REC_2026.prepare("SELECT count(*) AS n FROM messages").first("n");
    expect([201, 409]).toContain(res.status);
    expect(rows).toBe(res.status === 201 ? 1 : 0);
    expect((await send({ body: "もう一度" })).status).toBe(409);
  });
});
