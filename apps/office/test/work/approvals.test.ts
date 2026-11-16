// オーナーの承認の種類ごとの動き。社員の追加は記録だけ、外部連携と費用の増える事はパスキーで確かめ、ほかの所で決める種類は断る (タスクとレビューの 3.1)
import { newId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { finishTask } from "../../src/gate/work/loop.ts";
import { wrapDb } from "../helpers/github.ts";
import { api, clockIn, idOf, MINUTE, purposeAndGoal, rows, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

const ApprovalRow = z.object({ id: z.string(), kind: z.string(), status: z.string(), reason: z.string().nullable() }).loose();

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 開発担当のタスクを 1 つ作って取らせ、ask_owner で承認を求めさせる
 * @param w テストの物
 * @param kind 外部連携か費用の増える事
 * @returns 承認 ID とタスク ID
 */
async function asked(w: WorkWorld, kind: "external_integration" | "cost_increase"): Promise<{ approvalId: string; nodeId: string }> {
  // 勤務の前にオーナーがタスクを足すと呼び出しになり、タスクを離れると退勤するので、先に出勤させる
  await clockIn(w, "builder");
  const { goal } = await purposeAndGoal(w);
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "通知" }, 201));
  const nodeId = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "通知を外へ送る", taskKind: "build", assignee: "builder", priority: 1 }, 201));
  // 答えを待つ間に進める 2 つ目のタスク
  await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "通知の文を直す", taskKind: "build", assignee: "builder", priority: 2 }, 201);
  await staffOf(w, "builder").pull(w.clock.now());
  expect(await tool(w, "builder", "ask_owner", { kind, target: kind === "external_integration" ? "Slack" : "Workers の有料プラン", reason: "要件に要る" })).toMatchObject({ isError: false });
  const [approval] = z.array(ApprovalRow).parse(await api(w, "GET", "/api/v1/approvals"));
  return { approvalId: String(approval?.id), nodeId };
}

/**
 * 承認をパスキー無しで断り、確かめた後に通す事を確かめる
 * @param w テストの物
 * @param kind 外部連携か費用の増える事
 */
async function stepUpFirst(w: WorkWorld, kind: "external_integration" | "cost_increase"): Promise<void> {
  const { approvalId, nodeId } = await asked(w, kind);
  expect(await api(w, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "よい" }, 401)).toMatchObject({ code: "step_up_required" });
  expect(await statusOf(w, "approvals", approvalId)).toBe("pending");
  expect(await statusOf(w, "nodes", nodeId)).toBe("waiting_owner");

  await stepUp(w);
  expect(await api(w, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "よい" })).toMatchObject({ status: "approved", reason: "よい" });
  expect(await statusOf(w, "nodes", nodeId)).toBe("todo");
  // 決めた承認をもう 1 度決める事はできない
  await api(w, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "よい" }, 409);
}

/**
 * 承認を求めるタスクの無い承認の行を直に置く
 * @param w テストの物
 * @param kind 種類
 * @returns 承認 ID
 */
async function pending(w: WorkWorld, kind: string): Promise<string> {
  const id = newId(w.clock);
  await w.d1.DB.prepare("INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES (?, ?, 'example/know-office', '{}', 'pending', 'builder', ?)")
    .bind(id, kind, w.clock.now())
    .run();
  return id;
}

const statusOf = async (w: WorkWorld, table: "approvals" | "nodes", id: string) => (await rows(w.d1.DB, `SELECT status FROM ${table} WHERE id = ?`, id))[0]?.["status"];

describe("承認を求める", () => {
  it("社員が承認を求めると、オーナーに通知が出る", async () => {
    const { approvalId } = await asked(world, "external_integration");
    expect(await rows(world.d1.DB, "SELECT level, kind, title, body FROM notices WHERE kind = 'approval_requested'")).toEqual([
      { level: "info", kind: "approval_requested", title: "承認を待っています: 外部連携", body: "開発担当: Slack" },
    ]);
    expect(await statusOf(world, "approvals", approvalId)).toBe("pending");
  });
});

describe("社員の追加", () => {
  it("承認しても社員は増えず、承認を残してタスクに戻す", async () => {
    await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    // 開発担当の山が空なので、社長に目標を分けるタスクが立つ
    await staffOf(world, "builder").pull(world.clock.now());
    await staffOf(world, "president").pull(world.clock.now());
    const [plan] = await rows(world.d1.DB, "SELECT id FROM nodes WHERE assignee = 'president' AND status = 'doing'");
    await tool(world, "president", "staff_request", { kind: "staff_add", role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" });
    const [approval] = z.array(ApprovalRow).parse(await api(world, "GET", "/api/v1/approvals"));

    expect(await api(world, "POST", `/api/v1/approvals/${String(approval?.id)}/decision`, { decision: "approve", reason: "足してよい" })).toMatchObject({ status: "approved" });
    expect(await rows(world.d1.DB, "SELECT id FROM staff ORDER BY id")).toHaveLength(3);
    expect(await statusOf(world, "nodes", String(plan?.["id"]))).not.toBe("waiting_owner");
    expect(world.gate.audits.filter((a) => a.action === "approval.decide")).toEqual([expect.objectContaining({ detail: { kind: "staff_add", decision: "approve" } })]);
    // 戻ったタスクで同じ事を求めても、新しい承認は立たず承認済みを返す
    expect(await statusOf(world, "nodes", String(plan?.["id"]))).toBe("doing");
    const again = await tool(world, "president", "staff_request", { kind: "staff_add", role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" });
    expect(Answer.parse(JSON.parse(again.content))).toEqual({ approvalId: String(approval?.id), status: "approved", reason: "足してよい" });
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM approvals")).toEqual([{ n: 1 }]);
  });
});

describe("大事な操作の前にパスキーで確かめる", () => {
  // 外部連携と費用の増える事の承認はパスキーで確かめ、確かめるまで承認を待ったままにする
  it("費用の増える事と外部連携の承認", async () => {
    await expect(stepUpFirst(world, "external_integration")).resolves.toBeUndefined();
  });

  it("費用の増える事の承認も、パスキーで確かめるまで待ったままにする", async () => {
    await expect(stepUpFirst(world, "cost_increase")).resolves.toBeUndefined();
  });

  it("差し戻しはパスキー無しで通る", async () => {
    const { approvalId, nodeId } = await asked(world, "cost_increase");
    expect(await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "reject", reason: "今月は増やさない" })).toMatchObject({ status: "rejected" });
    expect(await statusOf(world, "nodes", nodeId)).toBe("todo");
  });

  it("同じ承認を同時に 2 度決めると、片方は 409", async () => {
    const { approvalId } = await asked(world, "cost_increase");
    await stepUp(world);
    const decide = (decision: string) =>
      world.gate.request(`/api/v1/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { ...world.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: "同時に決める" }),
      });
    const statuses = (await Promise.all([decide("approve"), decide("reject")])).map((r) => r.status);
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(world.gate.audits.filter((a) => a.action === "approval.decide")).toHaveLength(1);
  });
});

/**
 * 同じ承認を、承認と差し戻しで同時に決める
 * @param w テストの物
 * @param id 承認 ID
 * @returns 2 つのステータス。小さい順
 */
async function decideTwice(w: WorkWorld, id: string): Promise<number[]> {
  const decide = (decision: string) =>
    w.gate.request(`/api/v1/approvals/${id}/decision`, {
      method: "POST",
      headers: { ...w.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: "同時に決める" }),
    });
  return (await Promise.all([decide("approve"), decide("reject")])).map((r) => r.status).toSorted((a, b) => a - b);
}

describe("同時に決める", () => {
  it("役の変更を承認と差し戻しで同時に決めると、片方だけが入り、役は決めた側に合う", async () => {
    const id = newId(world.clock);
    await world.d1.DB.prepare("INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES (?, 'role_change', 'builder', ?, 'pending', 'president', ?)")
      .bind(id, JSON.stringify({ target: "builder", role: "開発と運用の担当", bossId: "president" }), world.clock.now())
      .run();
    expect(await decideTwice(world, id)).toEqual([200, 409]);
    const [decided] = await rows(world.d1.DB, "SELECT status FROM approvals WHERE id = ?", id);
    const [role] = await rows(world.d1.DB, "SELECT role FROM staff WHERE id = 'builder'");
    expect(role?.["role"]).toBe(decided?.["status"] === "approved" ? "開発と運用の担当" : "開発担当");
  });

  it("サービスを閉じる案を同時に決めると、片方だけが入る", async () => {
    const [service] = await rows(world.d1.DB, "SELECT id FROM services WHERE stage IN ('service', 'operation') LIMIT 1");
    const id = newId(world.clock);
    await world.d1.DB.prepare("INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES (?, 'service_close', ?, '{\"reason\":\"使われていない\"}', 'pending', 'president', ?)")
      .bind(id, service?.["id"], world.clock.now())
      .run();
    const count = async () => (await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM service_events WHERE service_id = ?", service?.["id"]))[0]?.["n"];
    const before = Number(await count());
    expect(await decideTwice(world, id)).toEqual([200, 409]);
    const [decided] = await rows(world.d1.DB, "SELECT status FROM approvals WHERE id = ?", id);
    const [stage] = await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", service?.["id"]);
    expect(stage?.["stage"] === "closed").toBe(decided?.["status"] === "approved");
    expect(Number(await count()) - before).toBe(decided?.["status"] === "approved" ? 1 : 0);
  });
});

describe("ほかの所で決める種類", () => {
  for (const kind of ["merge", "deploy", "prompt_rule", "guard_change"]) {
    it(`${kind} は承認を断って待ったままにし、差し戻しは受ける`, async () => {
      await stepUp(world);
      const id = await pending(world, kind);
      expect(await api(world, "POST", `/api/v1/approvals/${id}/decision`, { decision: "approve", reason: "よい" }, 409)).toMatchObject({ code: "conflict" });
      expect(await statusOf(world, "approvals", id)).toBe("pending");
      expect(await api(world, "POST", `/api/v1/approvals/${id}/decision`, { decision: "reject", reason: "ここでは決めない" })).toMatchObject({ status: "rejected" });
    });
  }
});

/**
 * 開発担当の今のタスクを終える
 * @param w テストの物
 */
async function finishCurrent(w: WorkWorld): Promise<void> {
  const { nodeId } = await w.gate.staff.builder.book.status(w.clock.now());
  await finishTask(w.gate.env, "builder", String(nodeId), w.clock.now());
}

const Answer = z.object({ approvalId: z.string(), status: z.string(), reason: z.string().nullable().optional() }).strict();

/**
 * タスクの出来事のうち、始めた時の中身を新しい順に読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns started の中身
 */
async function startedDetails(w: WorkWorld, nodeId: string): Promise<unknown[]> {
  const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.unknown() })) }).loose().parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  return detail.events.filter((e) => e.kind === "started").map((e) => e.detail);
}

/**
 * バッチの最後に必ず落ちる文を足し、バッチ全体を落とす。D1 のバッチは 1 つが落ちると全部を戻す
 * @param w テストの物
 * @returns 元に戻す関数
 */
function failBatches(w: WorkWorld): () => void {
  return wrapDb(w, { batch: (real, statements) => real([...statements, w.d1.DB.prepare("INSERT INTO no_such_table VALUES (1)")]) });
}

describe("オーナーに上げる事", () => {
  it("承認されたら社員が進める", async () => {
    const { approvalId, nodeId } = await asked(world, "external_integration");
    await stepUp(world);
    await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "つないでよい" });
    // 待つ間のタスクを終えると戻ったタスクを取り直し、承認の答えがタスクの文脈に入る
    await finishCurrent(world);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).nodeId).toBe(nodeId);
    expect((await startedDetails(world, nodeId)).at(-1)).toMatchObject({ approval: { id: approvalId, kind: "external_integration", status: "approved", reason: "つないでよい" } });
    // 同じ事をもう 1 度求めても新しい承認は立たず、承認済みを返して先へ進める
    const again = await tool(world, "builder", "ask_owner", { kind: "external_integration", target: "Slack", reason: "要件に要る" });
    expect(Answer.parse(JSON.parse(again.content))).toEqual({ approvalId, status: "approved", reason: "つないでよい" });
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM approvals")).toEqual([{ n: 1 }]);
    expect(await statusOf(world, "nodes", nodeId)).toBe("doing");
  });

  it("差し戻しの理由を読んで直す", async () => {
    const { approvalId, nodeId } = await asked(world, "cost_increase");
    await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "reject", reason: "無料の枠で作る" });
    await finishCurrent(world);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).nodeId).toBe(nodeId);
    expect((await startedDetails(world, nodeId)).at(-1)).toMatchObject({ approval: { status: "rejected", reason: "無料の枠で作る" } });
    const again = await tool(world, "builder", "ask_owner", { kind: "cost_increase", target: "Workers の有料プラン", reason: "要件に要る" });
    expect(Answer.parse(JSON.parse(again.content))).toEqual({ approvalId, status: "rejected", reason: "無料の枠で作る" });
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM approvals")).toEqual([{ n: 1 }]);
  });
});

describe("承認の決まり", () => {
  it("承認を求める途中で落ちると、承認も通知も残らず、タスクは作業中のまま", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "通知" }, 201));
    const nodeId = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "通知を外へ送る", taskKind: "build", assignee: "builder", priority: 1 }, 201));
    await clockIn(world, "builder");
    await staffOf(world, "builder").pull(world.clock.now());
    const restore = failBatches(world);
    await expect(tool(world, "builder", "ask_owner", { kind: "cost_increase", target: "有料プラン", reason: "要る" })).rejects.toThrow(/no_such_table/);
    restore();
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM approvals")).toEqual([{ n: 0 }]);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM notices WHERE kind = 'approval_requested'")).toEqual([{ n: 0 }]);
    expect(await statusOf(world, "nodes", nodeId)).toBe("doing");
  });

  it("決める途中で落ちると、承認は待ったまま、タスクも待ったまま", async () => {
    const { approvalId, nodeId } = await asked(world, "cost_increase");
    await stepUp(world);
    const restore = failBatches(world);
    await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "よい" }, 500);
    restore();
    expect(await statusOf(world, "approvals", approvalId)).toBe("pending");
    expect(await statusOf(world, "nodes", nodeId)).toBe("waiting_owner");
    expect(world.gate.audits.filter((a) => a.action === "approval.decide")).toEqual([]);
  });

  it("確認から 15 分ちょうどで切れ、その 1 ミリ秒前までは通る", async () => {
    const first = await asked(world, "cost_increase");
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now()).run();
    await api(world, "POST", `/api/v1/approvals/${first.approvalId}/decision`, { decision: "approve", reason: "よい" }, 401);
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now() + 1).run();
    expect(await api(world, "POST", `/api/v1/approvals/${first.approvalId}/decision`, { decision: "approve", reason: "よい" })).toMatchObject({ status: "approved" });
  });

  it("無い承認は、確かめる前に 404 にする", async () => {
    expect(await api(world, "POST", "/api/v1/approvals/0190f4a8-0000-7000-8000-00000000ffff/decision", { decision: "approve", reason: "よい" }, 404)).toMatchObject({ code: "not_found" });
  });
});
