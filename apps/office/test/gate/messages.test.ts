// 社員とのメッセージのルート。オーナーの発言を記録に足し、長い本文は R2 に置き、配信 DO に渡す (社員と自動の 3.7、ルートの一覧の 1.6)
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
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

const Message = z.object({ id: z.string(), at: z.string(), staffId: z.string(), nodeId: z.string().nullable(), sender: z.string(), body: z.string() }).strict();
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
    expect(gate.live.published).toContainEqual({ type: "message", message: { ...made, truncated: false } });
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
