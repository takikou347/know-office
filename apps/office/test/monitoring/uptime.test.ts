// 止まらなさ: 5 分ごとの定期ジョブが部分ごとの稼働を health_checks に残し、記録の画面が読む月の稼働率をそこから出す (サービスと拡張の 3.5)
import type { StaffId } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkHealth } from "../../src/gate/ledger/uptime.ts";
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
 * 1 つの社員 DO の答えを決めた長さだけ遅らせた env を作る。時計はほかの部分と共にあるので、ほかが答えた後に進める
 * @param late 遅らせる社員
 * @param ms 遅らせる長さ
 * @returns env
 */
function envWithSlow(late: StaffId, ms: number): typeof gate.env {
  const staff = gate.env.STAFF;
  const slow = {
    idFromName: (name: StaffId) => name,
    get: (name: StaffId) =>
      name === late
        ? {
            status: async () => {
              await new Promise((resolve) => setTimeout(resolve, 500));
              clock.advance(ms);
              return null;
            },
          }
        : staff.get(staff.idFromName(name)),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ...gate.env, STAFF: slow } as unknown as typeof gate.env;
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
    // 社員 DO の 1 つが答えるまでに 4 秒かかる。通るが、遅れとして知らせる
    await checkHealth(envWithSlow("reviewer", 4_000), clock);
    const items = Notices.parse(await (await gate.request("/api/v1/notices", { headers })).json()).data;
    expect(items).toEqual([expect.objectContaining({ level: "warn", kind: "health_slow", scope: "office", link: "/records" })]);
    expect(items[0]?.title).toContain("staff:reviewer");
    const row = await d1.DB.prepare("SELECT ok FROM health_checks WHERE part = 'staff:reviewer'").first();
    expect(row).toEqual({ ok: 1 });
  });

  it("答えが 3 秒ちょうどまでなら知らせない", async () => {
    await checkHealth(envWithSlow("reviewer", 3_000), clock);
    expect(Notices.parse(await (await gate.request("/api/v1/notices", { headers })).json()).data).toEqual([]);
  });

  it("同じ部分の故障は、読むまで重ねず、読んだ後にまた落ちれば知らせる", async () => {
    await Promise.all([checkHealth(envWithFailing("builder"), clock), checkHealth(envWithFailing("builder"), clock)]);
    moveTo(at(16, 10, 5));
    await checkHealth(envWithFailing("builder"), clock);
    // ほかの部分の故障は別に知らせる
    await checkHealth(envWithFailing("president"), clock);
    let items = Notices.parse(await (await gate.request("/api/v1/notices", { headers })).json()).data;
    expect(items.map((n) => n.title).toSorted()).toEqual([expect.stringContaining("staff:builder"), expect.stringContaining("staff:president")]);
    const builder = items.find((n) => n.title.includes("staff:builder"));
    await gate.request(`/api/v1/notices/${builder?.id ?? ""}/read`, { method: "PUT", headers });
    moveTo(at(16, 10, 10));
    await checkHealth(envWithFailing("builder"), clock);
    items = Notices.parse(await (await gate.request("/api/v1/notices", { headers })).json()).data;
    expect(items.filter((n) => n.title.includes("staff:builder"))).toHaveLength(2);
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
    await checkHealth(env, clock, 50);
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
