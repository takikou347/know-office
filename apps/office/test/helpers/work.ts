// タスクの繰り返しのテストの手伝い。D1、ゲートウェイ、GitHub の代わりを置き、木を作ってツールを呼ぶ (タスクとレビューの 4 章)
import type { D1Database } from "@cloudflare/workers-types";
import type { StaffId, ToolResult } from "@know-office/core";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { z } from "zod";
import type { Staff } from "../../src/gate/env.ts";
import type { Forge } from "../../src/gate/work/loop.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { fixedClock } from "./clock.ts";
import { createTestD1, resetMain, type TestD1 } from "./d1.ts";
import { createTestGate, type TestGate } from "./gate.ts";

export const MINUTE = 60_000;

/** テストで直すリポジトリ。公開のリポジトリの名前に人の名前を残さない */
export const REPO = "example/know-office";

/**
 * 2026-12-01 (日本時間) の時刻を返す。node_events は年ごとの REC_<年> に入るので、テストの D1 がある 2026 年にする
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
export function at(h: number, m = 0): number {
  return Date.UTC(2026, 11, 1, h - 9, m);
}

/** GitHub の代わり。出したプルリクエストと、main に入れたブランチを並べる */
export type FakeForge = Forge & {
  /** 出したプルリクエスト */
  pulls: { repo: string; branch: string; title: string }[];
  /** main に入れたブランチ */
  merged: string[];
  /** チェックが通っているか */
  checks: boolean;
  /** プルリクエストを出す間と main に入れる間に、ほかの要求を挟む */
  during: { openPull?: () => Promise<void>; merge?: () => Promise<void> };
};

/** テストの物 */
export type WorkWorld = {
  d1: TestD1;
  clock: ReturnType<typeof fixedClock>;
  gate: TestGate;
  forge: FakeForge;
  headers: Record<string, string>;
};

/**
 * GitHub の代わりを作る
 * @returns 出したプルリクエストを覚える代わり
 */
function fakeForge(): FakeForge {
  const forge: FakeForge = {
    pulls: [],
    merged: [],
    checks: true,
    during: {},
    openPull: async (input) => {
      await forge.during.openPull?.();
      forge.pulls.push({ repo: input.repo, branch: input.branch, title: input.title });
      return { number: forge.pulls.length, baseSha: "a".repeat(40), headSha: "b".repeat(40) };
    },
    checksPassed: () => Promise.resolve(forge.checks),
    merge: async (_repo, branch) => {
      await forge.during.merge?.();
      forge.merged.push(branch);
    },
  };
  return forge;
}

/**
 * 要件ごとの describe で、D1 を 1 つ作ってテストごとに空にし、8 時にログインしたゲートウェイを置く
 * @returns テストの物
 */
export function useWork(): WorkWorld {
  // beforeEach で中身を入れる
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const world = {} as WorkWorld;
  beforeAll(async () => {
    world.d1 = await createTestD1();
  }, 30_000);
  afterAll(() => world.d1.dispose());
  beforeEach(async () => {
    await resetMain(world.d1.DB);
    world.clock = fixedClock(at(8));
    world.gate = await createTestGate({ clock: world.clock, d1: world.d1 });
    world.forge = fakeForge();
    world.headers = await world.gate.signIn();
  }, 30_000);
  return world;
}

/**
 * 時計を進め、ログインし直し、ハートビートを送る。ログインの証明は短い間で切れるので、進めた後に作る
 * @param world テストの物
 * @param to 進める先
 */
export async function advance(world: WorkWorld, to: number): Promise<void> {
  world.clock.advance(to - world.clock.now());
  world.headers = await world.gate.signIn();
  // ワークスペースの代わりに、出勤している社員のハートビートを送る。届かないと 90 秒で待っている事になる
  for (const s of Object.values(world.gate.staff)) await s.book.heartbeat(to);
}

/**
 * JSON の本文で API を呼び、data を返す
 * @param world テストの物
 * @param method メソッド
 * @param path パス
 * @param body 本文
 * @param status 待つステータス
 * @returns 返った data
 */
export async function api(world: WorkWorld, method: string, path: string, body?: unknown, status = 200): Promise<unknown> {
  const init: RequestInit = { method, headers: { ...world.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await world.gate.request(path, init);
  const json: unknown = await res.json();
  expect({ status: res.status, json }).toMatchObject({ status });
  return res.ok ? z.object({ data: z.unknown() }).loose().parse(json).data : json;
}

/**
 * 作った物の ID を読む
 * @param data 返った data
 * @returns ID
 */
export function idOf(data: unknown): string {
  return z.object({ id: z.string() }).loose().parse(data).id;
}

/**
 * 目的と目標を API で置く
 * @param world テストの物
 * @returns 目的と目標の ID
 */
export async function purposeAndGoal(world: WorkWorld): Promise<{ purpose: string; goal: string }> {
  const purpose = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "purpose", scope: "office", title: "AI の社員が自分で回る会社にする" }, 201));
  const goal = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "goal", parentId: purpose, scope: "office", title: "know-office を動かし始める" }, 201));
  return { purpose, goal };
}

/**
 * 社員の DO を返す
 * @param world テストの物
 * @param staffId 社員 ID
 * @returns 社員 DO の代わり
 */
export function staffOf(world: WorkWorld, staffId: StaffId): Staff {
  return world.gate.env.STAFF.get(world.gate.env.STAFF.idFromName(staffId));
}

/**
 * 社員を 9 時に出勤させる
 * @param world テストの物
 * @param ids 出勤させる社員
 */
export async function clockIn(world: WorkWorld, ...ids: StaffId[]): Promise<void> {
  for (const id of ids) {
    await world.gate.staff[id].book.wake(at(8));
    await world.gate.staff[id].book.wake(at(9));
  }
  await advance(world, at(9));
}

/**
 * 社員のツールを呼ぶ
 * @param world テストの物
 * @param staffId 呼ぶ社員
 * @param name ツールの名前
 * @param input 入力
 * @returns ツールの答え
 */
export function tool(world: WorkWorld, staffId: StaffId, name: string, input: unknown): Promise<ToolResult> {
  return runTool(world.gate.env, world.forge, { staffId, tool: name, input, now: world.clock.now() });
}

/**
 * D1 の行を読む
 * @param db 読む D1
 * @param sql SQL
 * @param args 置き換える値
 * @returns 行
 */
export async function rows(db: D1Database, sql: string, ...args: unknown[]): Promise<Record<string, unknown>[]> {
  return (await db.prepare(sql).bind(...args).all()).results;
}
