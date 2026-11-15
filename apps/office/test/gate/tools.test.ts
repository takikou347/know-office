// 社員のツールを呼ぶ口 (POST /ws/v1/tools/{toolName}) を、作業トークンから承認とタスクの移りまで確かめる (社員が考えるの 3.5、タスクとレビューの 1.2)
import type { D1Database } from "@cloudflare/workers-types";
import type { StaffId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Caller, routeEgress } from "../../src/gate/egress.ts";
import { defineExtension, type ExtensionDefinition } from "../../src/gate/extensions/define.ts";
import { INSTALLED } from "../../src/gate/extensions/installed.ts";
import { toggleExtension } from "../../src/gate/extensions/state.ts";
import { finishTask } from "../../src/gate/work/loop.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { wrapDb } from "../helpers/github.ts";
import { api, clockIn, idOf, purposeAndGoal, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/** 成功の返事の形 */
const Answer = z.object({ data: z.object({ content: z.string(), isError: z.boolean() }).strict(), meta: z.object({ traceId: z.string() }).strict() }).strict();

/** 1 つのテストの社員、タスク、作業トークン */
type Work = { staffId: StaffId; nodeId: string; token: string };

/**
 * 目標の下に、開発担当のタスクを 2 つ置く
 * @param w テストの物
 * @returns タスクの ID
 */
async function twoTasks(w: WorkWorld): Promise<[string, string]> {
  const { goal } = await purposeAndGoal(w);
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
  const make = async (title: string, priority: number) =>
    idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title, taskKind: "build", assignee: "builder", priority }, 201));
  return [await make("勤怠の表をつなぐ", 1), await make("勤怠の訂正を出す", 2)];
}

/**
 * 社員に今のタスクを取らせ、そのタスクの作業トークンを出す
 * @param w テストの物
 * @param staffId 社員 ID
 * @returns 社員、タスク、作業トークン
 */
async function startWork(w: WorkWorld, staffId: StaffId): Promise<Work> {
  await staffOf(w, staffId).pull(w.clock.now());
  const { nodeId } = await w.gate.staff[staffId].book.status(w.clock.now());
  if (nodeId === null) throw new Error("タスクを取れなかった");
  const { token } = await issueTicket(w.gate.env, staffId, nodeId, w.clock.now());
  return { staffId, nodeId, token };
}

/**
 * 開発担当を出勤させ、タスクを 1 つ取らせる
 * @param w テストの物
 * @returns 社員、タスク、作業トークン
 */
async function builderAtWork(w: WorkWorld): Promise<Work> {
  await clockIn(w, "builder");
  await twoTasks(w);
  return startWork(w, "builder");
}

/**
 * ワークスペースの MCP の受け手と同じ形で社員のツールを呼ぶ
 * @param w テストの物
 * @param work 社員と作業トークン
 * @param toolName ツールの名前
 * @param toolInput ツールの入力
 * @param extensions 読み込んだ拡張
 * @returns 受け手の返事
 */
function call(w: WorkWorld, work: Work, toolName: string, toolInput: unknown, extensions: readonly ExtensionDefinition[] = INSTALLED): Promise<Response> {
  const caller: Caller = { staffId: work.staffId, workspaceId: workspaceIdOf(w.gate.env, work.staffId) };
  const request = new Request(`http://gate.internal/ws/v1/tools/${toolName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${work.token}`, "content-type": "application/json" },
    body: JSON.stringify({ toolInput }),
  });
  return routeEgress(request, w.gate.env, caller, { clock: w.clock, guard: w.gate.deps, extensions });
}

/**
 * 返事のステータスと code を読む
 * @param res 返事
 * @returns ステータスと code
 */
async function problem(res: Response): Promise<{ status: number; code: unknown }> {
  const body = z.object({ code: z.string() }).loose().parse(await res.json());
  return { status: res.status, code: body.code };
}

/**
 * 承認の行を読む
 * @param db 今の状態の D1
 * @returns 種類と要求した社員
 */
function approvals(db: D1Database) {
  return rows(db, "SELECT kind, requested_by FROM approvals ORDER BY requested_at, id");
}

/**
 * タスクの状態を読む
 * @param db 今の状態の D1
 * @param nodeId タスク ID
 * @returns 状態
 */
async function statusOf(db: D1Database, nodeId: string): Promise<unknown> {
  return (await rows(db, "SELECT status FROM nodes WHERE id = ?", nodeId))[0]?.["status"];
}

const ASK_OWNER = { kind: "external_integration", target: "Slack", reason: "通知を Slack に送る要件がある" };

describe("組織図", () => {
  it("社員が社員を足そうとする", async () => {
    await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    // 手の空いた開発担当が社長に次を求め、社長に plan のタスクが来る
    await staffOf(world, "builder").pull(world.clock.now());
    const work = await startWork(world, "president");

    const res = await call(world, work, "staff_request", { kind: "staff_add", role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" });
    expect(res.status).toBe(200);
    const { data } = Answer.parse(await res.json());
    expect(data.isError).toBe(false);
    expect(z.object({ approvalId: z.uuid() }).strict().safeParse(JSON.parse(data.content)).success).toBe(true);
    expect(await approvals(world.d1.DB)).toEqual([{ kind: "staff_add", requested_by: "president" }]);
    expect(await statusOf(world.d1.DB, work.nodeId)).toBe("waiting_owner");
    expect(await rows(world.d1.DB, "SELECT id FROM staff ORDER BY id")).toHaveLength(3);
  });
});

describe("オーナーに上げる事", () => {
  it("新しい外部連携が要る", async () => {
    const work = await builderAtWork(world);
    const res = await call(world, work, "ask_owner", ASK_OWNER);
    expect(res.status).toBe(200);
    expect(await approvals(world.d1.DB)).toEqual([{ kind: "external_integration", requested_by: "builder" }]);
    expect(await statusOf(world.d1.DB, work.nodeId)).toBe("waiting_owner");
  });
});

describe("社員のツールの口", () => {
  it("作業トークンが無いか、違う時は 401 で断る", async () => {
    const work = await builderAtWork(world);
    expect((await call(world, { ...work, token: "" }, "ask_owner", ASK_OWNER)).status).toBe(401);
    expect((await call(world, { ...work, token: `${work.token}x` }, "ask_owner", ASK_OWNER)).status).toBe(401);
    expect(await approvals(world.d1.DB)).toEqual([]);
  });

  it("社員かタスクか全体が止まっていれば 409 stopped で断り、何も書かない", async () => {
    const work = await builderAtWork(world);
    await world.d1.DB.prepare("INSERT INTO stops (id, at, kind, scope, target, signal, measured, threshold, rules_version, by) VALUES (?, ?, 'stop', 'task', ?, 'manual', 1, 1, 0, 'owner')")
      .bind(crypto.randomUUID(), world.clock.now(), work.nodeId)
      .run();
    expect(await problem(await call(world, work, "ask_owner", ASK_OWNER))).toEqual({ status: 409, code: "stopped" });
    expect(await approvals(world.d1.DB)).toEqual([]);
    expect(await statusOf(world.d1.DB, work.nodeId)).toBe("doing");
  });

  it("役で使えないツールは 404 not_found で断る", async () => {
    const work = await builderAtWork(world);
    expect(await problem(await call(world, work, "node_create", { kind: "task", parentId: crypto.randomUUID(), title: "足す" }))).toEqual({ status: 404, code: "not_found" });
    expect(await problem(await call(world, work, "staff_request", { kind: "staff_add", role: "x", bossId: "president", reason: "x" }))).toEqual({ status: 404, code: "not_found" });
  });

  it("形の違うツールの名前と長すぎる名前は 422 で断る", async () => {
    const work = await builderAtWork(world);
    expect((await call(world, work, "Ask_Owner", ASK_OWNER)).status).toBe(422);
    expect((await call(world, work, "ext__Bad__x", {})).status).toBe(422);
    expect((await call(world, work, "a".repeat(101), {})).status).toBe(422);
    expect((await call(world, work, "a".repeat(100), {})).status).toBe(404);
  });

  it("入力がツールの形に合わなければ 422 で断り、何も書かない", async () => {
    const work = await builderAtWork(world);
    expect(await problem(await call(world, work, "ask_owner", { ...ASK_OWNER, kind: "merge" }))).toEqual({ status: 422, code: "validation_failed" });
    expect(await problem(await call(world, work, "ask_owner", { ...ASK_OWNER, extra: 1 }))).toEqual({ status: 422, code: "validation_failed" });
    expect((await call(world, work, "ask_owner", "文字")).status).toBe(422);
    expect(await approvals(world.d1.DB)).toEqual([]);
    expect(await statusOf(world.d1.DB, work.nodeId)).toBe("doing");
  });

  it("前のタスクの作業トークンでは、今のタスクを動かさない", async () => {
    const before = await builderAtWork(world);
    // 前のタスクを終えて次のタスクに移った後も、前のタスクの作業トークンが残っている
    await finishTask(world.gate.env, "builder", before.nodeId, world.clock.now());
    const now = await startWork(world, "builder");
    expect(now.nodeId).not.toBe(before.nodeId);
    expect(await problem(await call(world, before, "ask_owner", ASK_OWNER))).toEqual({ status: 409, code: "conflict" });
    expect(await approvals(world.d1.DB)).toEqual([]);
    expect(await statusOf(world.d1.DB, now.nodeId)).toBe("doing");
  });

  it("同じ社員が同時に 2 回オーナーに上げると、承認は 1 件だけ足し、もう 1 回は 409 で断る", async () => {
    const work = await builderAtWork(world);
    const answers = await Promise.all([call(world, work, "ask_owner", ASK_OWNER), call(world, work, "ask_owner", { ...ASK_OWNER, target: "Discord" })]);
    expect(answers.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await approvals(world.d1.DB)).toHaveLength(1);
    expect(await statusOf(world.d1.DB, work.nodeId)).toBe("waiting_owner");
  });

  it("承認を書けなければ、タスクを waiting_owner に残さない", async () => {
    const work = await builderAtWork(world);
    // 承認の行を足す文だけを落とす
    const restore = wrapDb(world, {
      prepare: (real, sql) => {
        if (/insert\s+into\s+"?approvals"?/i.test(sql)) throw new Error("承認を書けない");
        return real(sql);
      },
    });
    try {
      expect((await call(world, work, "ask_owner", ASK_OWNER)).status).toBe(500);
    } finally {
      restore();
    }
    expect(await approvals(world.d1.DB)).toEqual([]);
    expect(await statusOf(world.d1.DB, work.nodeId)).toBe("doing");
  });

  it("ルールの判断が断れば 403 rule_denied で断り、ルールの外の操作を 1 回数え、tool_calls に重ねない", async () => {
    // 鍵の名前を持つ拡張のツールは、入れていても鍵に触る試みとして断る
    const bad = defineExtension({ id: "test-bad", title: "鍵を読む", ownerData: false, routes: [], tools: { vault_read: { schema: z.object({}).strict(), run: () => Promise.resolve({ key: "x" }) } } });
    const extensions = [...INSTALLED, bad];
    const work = await builderAtWork(world);
    await toggleExtension(world.d1.DB, { id: "test-bad", enabled: true, now: world.clock.now() }, 0);
    expect(await problem(await call(world, work, "ext__test-bad__vault_read", {}, extensions))).toEqual({ status: 403, code: "rule_denied" });
    expect(await rows(world.d1.REC_2026, "SELECT id FROM tool_calls WHERE node_id = ?", work.nodeId)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT target, signal FROM stops WHERE kind = 'stop'")).toEqual([{ target: work.nodeId, signal: "rule_denied" }]);
  });

  it("入れた拡張のツールは ext__ の名前で動き、入れていない拡張のツールは 404 で断る", async () => {
    const work = await builderAtWork(world);
    expect(await problem(await call(world, work, "ext__sample-notes__note_read", {}))).toEqual({ status: 404, code: "not_found" });
    await toggleExtension(world.d1.DB, { id: "sample-notes", enabled: true, now: world.clock.now() }, 0);
    const res = await call(world, work, "ext__sample-notes__note_read", {});
    expect(res.status).toBe(200);
    expect(Answer.parse(await res.json()).data.isError).toBe(false);
  });
});
