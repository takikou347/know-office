// 止まらなさ: 5 分ごとの定期ジョブが部分ごとの稼働を health_checks に残し、記録の画面が読む月の稼働率をそこから出す (サービスと拡張の 3.5)
import type { StaffId } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkHealth, SLOW_PROBE_MS } from "../../src/gate/ledger/uptime.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - 9, m);

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  clock = fixedClock(at(16, 10));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const Notices = z.object({ data: z.array(z.object({ id: z.string(), level: z.string(), kind: z.string(), title: z.string(), scope: z.string(), link: z.string().nullable(), readAt: z.string().nullable() }).loose()) }).loose();
const Uptime = z.object({ data: z.object({ month: z.string(), ratio: z.number().nullable(), checks: z.number() }).strict() }).loose();

/**
 * 月の稼働率を読む
 * @param month 読む月
 * @returns 返事
 */
function uptime(month: string) {
  return gate.request(`/api/v1/records/uptime?month=${month}`, { headers });
}

/**
 * 1 人の社員 DO だけが答えない env を作る
 * @param failing 答えない社員
 * @returns env
 */
function envWithFailing(failing: StaffId): typeof gate.env {
  const staff = gate.env.STAFF;
  const broken = {
    idFromName: (name: StaffId) => name,
    get: (name: StaffId) => (name === failing ? { status: () => Promise.reject(new Error("社員 DO が応答しない")) } : staff.get(staff.idFromName(name))),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ...gate.env, STAFF: broken } as unknown as typeof gate.env;
}

/**
 * 時刻を進める
 * @param to 進める先
 */
function moveTo(to: number): void {
  clock.advance(to - clock.now());
}

/**
 * 1 つの部分だけ答えまでの長さを決めて返すストップウォッチを作る。ほかの部分は 0 にする
 * @param late 遅らせる部分
 * @param ms 答えまでの長さ
 * @returns checkHealth に渡すストップウォッチ
 */
function slowPart(late: string, ms: number): (part: string) => () => number {
  return (part) => () => (part === late ? ms : 0);
}

/**
 * 通知を読む
 * @returns 通知の並び
 */
async function readNotices() {
  return Notices.parse(await (await gate.request("/api/v1/notices", { headers })).json()).data;
}

describe("止まらなさ", () => {
  it("稼働率を見る", async () => {
    // 日本時間の 11 月 1 日 0 時ちょうどは今月、その 1 ミリ秒前は先月に数える
    const monthStart = Date.UTC(2026, 9, 31, 15);
    await d1.DB.prepare("INSERT INTO health_checks (id, at, part, ok, ms) VALUES ('019a7b00-0000-7000-8000-0000000000d1', ?, 'gate', 0, 0), ('019a7b00-0000-7000-8000-0000000000d2', ?, 'gate', 1, 0)")
      .bind(monthStart - 1, monthStart)
      .run();
    moveTo(at(16, 10, 5));
    await checkHealth(gate.env, clock);
    moveTo(at(16, 10, 10));
    await checkHealth(envWithFailing("builder"), clock);
    const parts = await d1.DB.prepare("SELECT part, ok FROM health_checks WHERE at = ? ORDER BY part").bind(at(16, 10, 10)).all();
    expect(parts.results).toEqual([
      { part: "d1", ok: 1 },
      { part: "gate", ok: 1 },
      { part: "recorder", ok: 1 },
      { part: "staff:builder", ok: 0 },
      { part: "staff:president", ok: 1 },
      { part: "staff:reviewer", ok: 1 },
    ]);
    // 6 つの部分を 2 回確かめた 12 件と、月の頭の 1 件のうち、通らなかったのは 1 件
    const res = await uptime("2026-11");
    expect(res.status).toBe(200);
    expect(Uptime.parse(await res.json()).data).toEqual({ month: "2026-11", ratio: 12 / 13, checks: 13 });
    // 先月は月の頭の 1 ミリ秒前の 1 件だけ
    expect(Uptime.parse(await (await uptime("2026-10")).json()).data).toEqual({ month: "2026-10", ratio: 0, checks: 1 });
  });

  it("故障を知らせる", async () => {
    await checkHealth(envWithFailing("builder"), clock);
    const res = await gate.request("/api/v1/notices", { headers });
    const items = Notices.parse(await res.json()).data;
    expect(items).toEqual([expect.objectContaining({ level: "warn", kind: "health_down", scope: "office", link: "/records", readAt: null })]);
    expect(items[0]?.title).toContain("staff:builder");
  });

  it("遅れを知らせる", async () => {
    // 社員 DO の 1 つが答えるまでに基準より 1 秒長くかかる。通るが、遅れとして知らせる
    await checkHealth(gate.env, clock, { stopwatch: slowPart("staff:reviewer", SLOW_PROBE_MS + 1_000) });
    const items = await readNotices();
    expect(items).toEqual([expect.objectContaining({ level: "warn", kind: "health_slow", scope: "office", link: "/records" })]);
    expect(items[0]?.title).toContain("staff:reviewer");
    const row = await d1.DB.prepare("SELECT ok FROM health_checks WHERE part = 'staff:reviewer'").first();
    expect(row).toEqual({ ok: 1 });
  });

  it("答えが基準ちょうどまでなら知らせない", async () => {
    await checkHealth(gate.env, clock, { stopwatch: slowPart("staff:reviewer", SLOW_PROBE_MS) });
    expect(await readNotices()).toEqual([]);
    await checkHealth(gate.env, clock, { stopwatch: slowPart("staff:reviewer", SLOW_PROBE_MS + 1) });
    expect(await readNotices()).toHaveLength(1);
  });

  it("故障を重ねない", async () => {
    // 同時に走った 2 つの確かめと、5 分後の確かめで、同じ部分の通知は 1 件。ほかの部分の故障は別に知らせる
    await Promise.all([checkHealth(envWithFailing("builder"), clock), checkHealth(envWithFailing("builder"), clock)]);
    moveTo(at(16, 10, 5));
    await checkHealth(envWithFailing("builder"), clock);
    await checkHealth(envWithFailing("president"), clock);
    const titles = (await readNotices()).map((n) => n.title).toSorted();
    expect(titles).toEqual([expect.stringContaining("staff:builder"), expect.stringContaining("staff:president")]);
  });

  it("読んだ後にまた落ちれば知らせる", async () => {
    await checkHealth(envWithFailing("builder"), clock);
    const [first] = await readNotices();
    expect((await gate.request(`/api/v1/notices/${first?.id ?? ""}/read`, { method: "PUT", headers })).status).toBe(204);
    moveTo(at(16, 10, 5));
    await checkHealth(envWithFailing("builder"), clock);
    expect(await readNotices()).toHaveLength(2);
  });

  it("通知を書けなくても確かめの行とほかの部分の通知を残し、エラーログに残す", async () => {
    // builder の通知だけ書けない D1 にする
    const db = gate.env.DB;
    const failing = {
      batch: db.batch.bind(db),
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("INSERT INTO notices")) return statement;
        return { bind: (...values: unknown[]) => (values.some((v) => String(v).includes("staff:builder")) ? { run: () => Promise.reject(new Error("D1 が答えない")) } : statement.bind(...values)) };
      },
    };
    const staff = gate.env.STAFF;
    const broken = {
      idFromName: (name: StaffId) => name,
      get: (name: StaffId) => (name === "builder" || name === "president" ? { status: () => Promise.reject(new Error("社員 DO が応答しない")) } : staff.get(staff.idFromName(name))),
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await checkHealth({ ...gate.env, DB: failing, STAFF: broken } as unknown as typeof gate.env, clock);
    const rows = await d1.DB.prepare("SELECT count(*) AS n FROM health_checks").first();
    expect(rows).toEqual({ n: 6 });
    expect((await readNotices()).map((n) => n.title)).toEqual([expect.stringContaining("staff:president")]);
    const { results } = await d1.REC_2026.prepare("SELECT code FROM error_events WHERE code = 'health_notice_failed'").all();
    expect(results).toEqual([{ code: "health_notice_failed" }]);
  });

  it("月の稼働率は、その月の確かめの行だけを索引で読む", async () => {
    // 確かめの行は消さずに年 60 万行ほど増えるので、月の稼働率が全部の行を読まない事を確かめる
    const plan = await d1.DB.prepare("EXPLAIN QUERY PLAN SELECT count(*) AS checks, coalesce(sum(ok), 0) AS passed FROM health_checks WHERE at >= ? AND at < ?").bind(0, 1).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toMatch(/SEARCH health_checks USING (?:COVERING )?INDEX health_checks_at \(at>\? AND at<\?\)/);
  });

  it("確かめの無い月は稼働率を出さず、形の違う月は 422", async () => {
    expect(Uptime.parse(await (await uptime("2026-12")).json()).data).toEqual({ month: "2026-12", ratio: null, checks: 0 });
    for (const month of ["2026-13", "2026-1", "202611", "2026-00"]) expect((await uptime(month)).status).toBe(422);
    expect((await gate.request("/api/v1/records/uptime", { headers })).status).toBe(422);
  });

  it("決めた時間を過ぎても答えない部分は、待たずに通らなかった事にする", async () => {
    const staff = gate.env.STAFF;
    const hanging = {
      idFromName: (name: StaffId) => name,
      get: (name: StaffId) => (name === "reviewer" ? { status: () => new Promise<never>(() => undefined) } : staff.get(staff.idFromName(name))),
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const env = { ...gate.env, STAFF: hanging } as unknown as typeof gate.env;
    // 時計は止めてあるので、待った長さは実の時間で測る
    const started = performance.now();
    await checkHealth(env, clock, { timeoutMs: 50 });
    expect(performance.now() - started).toBeLessThan(2000);
    const parts = await d1.DB.prepare("SELECT part, ok FROM health_checks WHERE part LIKE 'staff:%' ORDER BY part").all();
    expect(parts.results).toEqual([
      { part: "staff:builder", ok: 1 },
      { part: "staff:president", ok: 1 },
      { part: "staff:reviewer", ok: 0 },
    ]);
  });

  it("確かめを書けなくても投げず、エラーログに残す", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const env = { ...gate.env, DB: { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1 が答えない")), first: () => Promise.reject(new Error("D1 が答えない")) }) }), batch: () => Promise.reject(new Error("D1 が答えない")) } } as unknown as typeof gate.env;
    await expect(checkHealth(env, clock)).resolves.toBeUndefined();
    const { results } = await d1.REC_2026.prepare("SELECT code FROM error_events WHERE code = 'health_check_failed'").all();
    expect(results).toEqual([{ code: "health_check_failed" }]);
  });
});
