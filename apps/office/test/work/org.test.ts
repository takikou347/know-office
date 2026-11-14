// 組織図と、オーナーに上げる事。役目の説明文の版、社員の追加の承認待ち、新しい外部連携の承認待ち (タスクとレビューの 3.1)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { finishTask } from "../../src/gate/work/loop.ts";
import { api, at, advance, clockIn, idOf, purposeAndGoal, rows, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

const OrgRow = z.object({ id: z.string(), role: z.string(), bossId: z.string().nullable(), prompt: z.string(), promptVersion: z.number() }).loose();

/**
 * 組織図を読む
 * @param w テストの物
 * @returns 3 人の役、上司、説明文
 */
async function org(w: WorkWorld) {
  return z.array(OrgRow).parse(await api(w, "GET", "/api/v1/org"));
}

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
 * タスクを始めた時の役目の説明文の版を読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns started の出来事の promptVersion
 */
async function startedWith(w: WorkWorld, nodeId: string): Promise<unknown> {
  const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.record(z.string(), z.unknown()) })) }).loose().parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  return detail.events.find((e) => e.kind === "started")?.detail["promptVersion"];
}

describe("組織図", () => {
  it("役目の説明文を直す", async () => {
    expect((await org(world)).map((s) => [s.id, s.role, s.bossId, s.promptVersion])).toEqual([
      ["president", "社長", null, 1],
      ["builder", "開発担当", "president", 1],
      ["reviewer", "レビュー担当", "president", 1],
    ]);
    await clockIn(world, "builder");
    const [first, second] = await twoTasks(world);
    await staffOf(world, "builder").pull(world.clock.now());

    await advance(world, at(9, 30));
    const body = "無いデータを作らず、分からない所は「未確認」と書く。テストを先に書き、落ちた理由を 1 行残す。";
    expect(await api(world, "PUT", "/api/v1/staff/builder/prompt", { version: 1, body })).toEqual({ version: 2 });
    // 古い版を見て直した物は、後から来た方を断る
    await api(world, "PUT", "/api/v1/staff/builder/prompt", { version: 1, body: "古い版から直した" }, 409);
    expect((await org(world)).find((s) => s.id === "builder")).toMatchObject({ prompt: body, promptVersion: 2 });
    expect(world.gate.audits.map((a) => a.action)).toContain("staff.prompt");

    // 今のタスクは始めた時の版のまま、次のタスクから新しい版を使う
    await advance(world, at(10));
    await finishTask(world.gate.env, "builder", first, world.clock.now());
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ nodeId: second });
    expect(await startedWith(world, first)).toBe(1);
    expect(await startedWith(world, second)).toBe(2);
  });

  it("社員が社員を足そうとする", async () => {
    await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    await staffOf(world, "builder").pull(world.clock.now());
    await staffOf(world, "president").pull(world.clock.now());
    const [plan] = await rows(world.d1.DB, "SELECT id FROM nodes WHERE assignee = 'president' AND status = 'doing'");

    expect(await tool(world, "president", "staff_request", { kind: "staff_add", role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" })).toMatchObject({ isError: false });
    const approvals = z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), requestedBy: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/approvals?status=pending"));
    expect(approvals.map((a) => [a.kind, a.status, a.requestedBy])).toEqual([["staff_add", "pending", "president"]]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", plan?.["id"])).toEqual([{ status: "waiting_owner" }]);
    expect(await org(world)).toHaveLength(3);

    await api(world, "POST", `/api/v1/approvals/${String(approvals[0]?.id)}/decision`, { decision: "reject", reason: "今は 3 人で回す" });
    expect(await org(world)).toHaveLength(3);
    // 差し戻されたタスクは手の空いた社長に戻り、社長は理由を読んで続ける
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", plan?.["id"])).toEqual([{ status: "doing" }]);
    await api(world, "POST", `/api/v1/approvals/${String(approvals[0]?.id)}/decision`, { decision: "approve", reason: "やはり足す" }, 409);
  });
});

describe("オーナーに上げる事", () => {
  it("新しい外部連携が要る", async () => {
    await clockIn(world, "builder");
    const [first] = await twoTasks(world);
    await staffOf(world, "builder").pull(world.clock.now());

    expect(await tool(world, "builder", "ask_owner", { kind: "external_integration", target: "Slack", reason: "通知を Slack に送る要件がある" })).toMatchObject({ isError: false });
    const waiting = z.array(z.object({ id: z.string(), status: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/nodes?status=waiting_owner"));
    expect(JSON.stringify(waiting)).toContain(first);
    const [approval] = z.array(z.object({ id: z.string(), kind: z.string(), target: z.string(), payload: z.record(z.string(), z.unknown()) }).loose()).parse(await api(world, "GET", "/api/v1/approvals"));
    expect(approval).toMatchObject({ kind: "external_integration", target: "Slack", payload: { nodeId: first } });
    // 止まったタスクを離れ、開発担当は次のタスクを取る
    expect((await world.gate.staff.builder.book.status(world.clock.now())).nodeId).not.toBe(first);

    // 外部連携の承認の中身はまだ作っていないので、承認は断り、タスクは待ったままにする
    expect(await api(world, "POST", `/api/v1/approvals/${String(approval?.id)}/decision`, { decision: "approve", reason: "つないでよい" }, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT status FROM approvals WHERE id = ?", approval?.id)).toEqual([{ status: "pending" }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first)).toEqual([{ status: "waiting_owner" }]);
    await api(world, "POST", `/api/v1/approvals/${String(approval?.id)}/decision`, { decision: "reject", reason: "今はつながない" });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first)).toEqual([{ status: "todo" }]);
    expect(world.gate.audits.map((a) => a.action)).toContain("approval.decide");
  });
});

describe("組織図と承認の決まり", () => {
  it("組織図のカーソルは社員 ID だけを受け、違えば 400 で断る", async () => {
    expect(z.array(OrgRow).parse(await api(world, "GET", "/api/v1/org?limit=1&cursor=president")).map((s) => s.id)).toEqual(["builder"]);
    expect(await api(world, "GET", "/api/v1/org?cursor=nobody", undefined, 400)).toMatchObject({ code: "malformed_request" });
  });

  it("役の変更は承認で社員に入り、中身の形が違えば 422 で断って承認を待ったままにする", async () => {
    await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    await staffOf(world, "builder").pull(world.clock.now());
    await staffOf(world, "president").pull(world.clock.now());
    await tool(world, "president", "staff_request", { kind: "role_change", target: "builder", role: "開発と運用の担当", bossId: "president", reason: "運用の直しも任せる" });
    const [good] = z.array(z.object({ id: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/approvals"));
    await api(world, "POST", `/api/v1/approvals/${String(good?.id)}/decision`, { decision: "approve", reason: "任せる" });
    expect((await org(world)).find((s) => s.id === "builder")).toMatchObject({ role: "開発と運用の担当", bossId: "president" });

    const bad = "0190f4a8-0000-7000-8000-00000000abcd";
    await world.d1.DB.prepare("INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES (?, 'role_change', 'builder', '{\"target\":\"builder\"}', 'pending', 'president', ?)")
      .bind(bad, world.clock.now())
      .run();
    expect(await api(world, "POST", `/api/v1/approvals/${bad}/decision`, { decision: "approve", reason: "任せる" }, 422)).toMatchObject({ code: "validation_failed" });
    expect(await rows(world.d1.DB, "SELECT status FROM approvals WHERE id = ?", bad)).toEqual([{ status: "pending" }]);
  });
});
