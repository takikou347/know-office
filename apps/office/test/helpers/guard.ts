// 自動停止のテストの手伝い。D1 とゲートウェイを起こし、社員を出勤させ、タスクとサービスの行を置く
import type { StaffId } from "@know-office/core";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { fixedClock } from "./clock.ts";
import { createTestD1, resetMain, type TestD1 } from "./d1.ts";
import { createTestGate, type TestGate } from "./gate.ts";

export const MINUTE = 60_000;
export const NODE = "0190f4a8-0000-7000-8000-000000000101";
export const NODE2 = "0190f4a8-0000-7000-8000-000000000102";

/**
 * 2030-01-07 (日本時間) の時刻を返す
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
export function jst(h: number, m = 0): number {
  return Date.UTC(2030, 0, 7, h - 9, m);
}

/** 1 つのテストで使う物 */
export type GuardWorld = {
  clock: ReturnType<typeof fixedClock>;
  d1: TestD1;
  gate: TestGate;
};

/**
 * ファイルで D1 を 1 つ作り、テストごとに空にして、ゲートウェイと 3 人の社員の行を作る
 * @returns テストの中で読む物。beforeEach の後に中身が入る
 */
export function useGuardWorld(): GuardWorld {
  // 中身は beforeAll と beforeEach で入れ、テストの中だけで読む
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const world = {} as GuardWorld;
  beforeAll(async () => {
    world.d1 = await createTestD1();
  }, 30_000);
  afterAll(() => world.d1.dispose());
  beforeEach(async () => {
    await resetMain(world.d1.DB);
    world.clock = fixedClock(jst(8));
    world.gate = await createTestGate({ clock: world.clock, d1: world.d1 });
    const staff = [
      ["president", null],
      ["builder", "president"],
      ["reviewer", "president"],
    ] as const;
    await world.d1.DB.batch(
      staff.map(([id, boss]) =>
        world.d1.DB.prepare("INSERT OR REPLACE INTO staff (id, role, boss_id, model, effort, prompt_version, created_at) VALUES (?, ?, ?, 'claude-opus-5-5', 'high', 1, 0)").bind(id, id, boss),
      ),
    );
  }, 30_000);
  return world;
}

/**
 * 社員を 9 時に出勤させ、タスクを持たせる
 * @param world テストの物
 * @param staffId 社員 ID
 * @param nodeId 持たせるタスク。null なら持たせない
 */
export async function startWork(world: GuardWorld, staffId: StaffId, nodeId: string | null = NODE): Promise<void> {
  const { book } = world.gate.staff[staffId];
  await book.wake(jst(8));
  await book.wake(jst(9));
  if (nodeId === null) return;
  await addNode(world, nodeId, staffId);
  await book.take({ nodeId, title: `タスク ${nodeId.slice(-3)}`, scope: "office" }, null, jst(9));
}

/**
 * タスクの行を置く
 * @param world テストの物
 * @param nodeId タスク ID
 * @param assignee 持つ社員
 * @param scope office かサービスの ID
 */
export async function addNode(world: GuardWorld, nodeId: string, assignee: StaffId, scope = "office"): Promise<void> {
  await world.d1.DB.prepare(
    "INSERT OR IGNORE INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, created_by, created_at, updated_at) VALUES (?, 'task', NULL, ?, ?, 'doing', 1, ?, 'president', 0, 0)",
  )
    .bind(nodeId, scope, `タスク ${nodeId.slice(-3)}`, assignee)
    .run();
}

/**
 * サービスの行を置く
 * @param world テストの物
 * @param id サービス ID
 * @param kind library か web_app
 */
export async function addService(world: GuardWorld, id: string, kind: "library" | "web_app"): Promise<void> {
  await world.d1.DB.prepare("INSERT INTO services (id, name, kind, stage, created_at) VALUES (?, ?, ?, 'service', 0)").bind(id, id, kind).run();
}

/**
 * D1 の行を読む
 * @param world テストの物
 * @param sql SQL
 * @returns 行
 */
export async function rows(world: GuardWorld, sql: string): Promise<Record<string, unknown>[]> {
  return (await world.d1.DB.prepare(sql).all()).results;
}

/**
 * ルールの外の出来事を作る
 * @param nodeId タスク ID
 * @param target 相手
 * @param staffId 社員 ID
 * @returns rule_denied の出来事
 */
export function denied(nodeId = NODE, target = "/etc/passwd", staffId: StaffId = "builder") {
  return { type: "rule_denied", staffId, nodeId, operation: "file.read", target } as const;
}
