// 開発の通しが同じ日に流し直せるよう、社員の退勤した日の印を消す開発の道を、development の時だけ受ける事を確かめる (社員と勤怠の 3.1、ログインと記録の 3.9)
import { describe, expect, it } from "vitest";
import { entryFetch } from "../../src/gate/entry.ts";
import { devStaffRoute } from "../../src/gate/work/dev-staff.ts";
import type { Bindings } from "../../src/gate/env.ts";
import { at, clockIn, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * 開発担当を出勤させてから終わりの時刻で退勤させ、勤務の時刻を一日に広げる。その日はもう出勤しない
 */
async function builderLeftToday(): Promise<void> {
  await clockIn(world, "builder");
  world.clock.advance(at(17, 30) - world.clock.now());
  const book = world.gate.staff.builder.book;
  await book.wake(world.clock.now());
  expect((await book.status(world.clock.now())).state).toBe("off");
  await world.gate.env.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, created_at) VALUES (?, 'workday.schedule', 'office', ?, 99, 'owner', 0)")
    .bind("0190f4a8-0000-7000-8000-0000000000c9", JSON.stringify({ start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }))
    .run();
  await book.wake(world.clock.now());
  expect((await book.status(world.clock.now())).state).toBe("off");
}

/**
 * 開発の道を、テストの時計で受けさせる
 * @param env バインディング
 * @param path 道
 * @param method メソッド
 * @returns 返事。受けない時は null
 */
async function route(env: Bindings, path: string, method = "POST"): Promise<Response | null> {
  return devStaffRoute(new Request(`http://localhost:5174${path}`, { method }), env, { clock: world.clock });
}

/**
 * Worker の入口に開発の道を送る
 * @param env バインディング
 * @param path 道
 * @param method メソッド
 * @returns 返事
 */
async function send(env: Bindings, path: string, method = "POST"): Promise<Response> {
  return entryFetch(new Request(`http://localhost:5174${path}`, { method }), env);
}

describe("開発の通しで社員の退勤した日の印を消す", () => {
  it("development の時、退勤した日の印を消すと、その日の勤務の時間の中ならその場で出勤する", async () => {
    await builderLeftToday();
    expect((await route(world.gate.env, "/__dev/staff/builder/forget-day"))?.status).toBe(204);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).state).toBe("working");
  });

  it("印を消して出勤した社員は、始まりの時刻の alarm と同じく、手が空いていれば自分のタスクを取る", async () => {
    await builderLeftToday();
    const nodeId = "0190f4a8-0000-7000-8000-0000000001a1";
    await world.gate.env.DB.prepare(
      "INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, task_kind, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', '続きのタスク', 'todo', 1, 'builder', 'build', 'president', 0, 0)",
    )
      .bind(nodeId)
      .run();
    expect((await route(world.gate.env, "/__dev/staff/builder/forget-day"))?.status).toBe(204);
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "working", nodeId });
  });

  it("知らない社員と POST でない要求は 404 で断る", async () => {
    await builderLeftToday();
    expect((await route(world.gate.env, "/__dev/staff/nobody/forget-day"))?.status).toBe(404);
    expect((await route(world.gate.env, "/__dev/staff/builder/forget-day", "GET"))?.status).toBe(404);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).state).toBe("off");
  });

  it("DEV_FAKES_URL が手元でない時は 404 で断る", async () => {
    await builderLeftToday();
    const env = { ...world.gate.env, DEV_FAKES_URL: "https://fakes.example.com" };
    expect((await route(env, "/__dev/staff/builder/forget-day"))?.status).toBe(404);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).state).toBe("off");
  });

  it.each([["production"], ["preview"], [undefined]])("development でない所 (%s) の入口は受けず、印を消さない", async (environment) => {
    await builderLeftToday();
    const env = { ...world.gate.env, ENVIRONMENT: environment };
    expect(await route(env, "/__dev/staff/builder/forget-day")).toBeNull();
    // worker.ts の default export の fetch と同じ関数。ゲートウェイに任せ、開発の道は無い
    expect([401, 404]).toContain((await send(env, "/__dev/staff/builder/forget-day")).status);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).state).toBe("off");
  });
});
