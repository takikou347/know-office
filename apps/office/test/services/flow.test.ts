// アイデアから運用までの流れ。案を足し、社長が調べ、オーナーが段階ごとに決め、サービスから元の案をたどる (サービスと拡張の 3.1)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, clockIn, idOf, MINUTE, purposeAndGoal, rows, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

const Card = z.object({ id: z.string(), name: z.string(), kind: z.string(), stage: z.string(), staffId: z.string().nullable(), repo: z.string().nullable() }).strict();
const Detail = Card.extend({
  aim: z.string(),
  users: z.string(),
  costEstimateMicroUsd: z.number(),
  revenueEstimateMicroUsd: z.number(),
  study: z.string().nullable(),
  droppedReason: z.string().nullable(),
  metrics: z.record(z.string(), z.unknown()),
  events: z.array(z.object({ at: z.string(), kind: z.string(), by: z.string(), detail: z.record(z.string(), z.unknown()) }).strict()),
}).strict();

/** 動画を作るサービスの案。費用と売り上げは月の見込み */
const VIDEO = {
  title: "動画を作るサービス",
  kind: "web_app",
  aim: "説明の動画を文章から作る",
  users: "小さな会社の広報",
  costEstimateMicroUsd: 30_000_000,
  revenueEstimateMicroUsd: 120_000_000,
} as const;

/**
 * オーナーが案を足す
 * @param w テストの物
 * @returns サービス ID
 */
async function ownerIdea(w: WorkWorld): Promise<string> {
  return idOf(await api(w, "POST", "/api/v1/services", VIDEO, 201));
}

/**
 * オーナーが段階を移す
 * @param w テストの物
 * @param serviceId サービス ID
 * @param body 移る先と理由
 * @param status 待つステータス
 * @returns 返った data
 */
function advance(w: WorkWorld, serviceId: string, body: Record<string, unknown>, status = 200): Promise<unknown> {
  return api(w, "POST", `/api/v1/services/${serviceId}/advance`, body, status);
}

/**
 * サービスの詳細を読む
 * @param w テストの物
 * @param serviceId サービス ID
 * @returns 詳細
 */
async function detailOf(w: WorkWorld, serviceId: string): Promise<z.infer<typeof Detail>> {
  return Detail.parse(await api(w, "GET", `/api/v1/services/${serviceId}`));
}

/** 調べた材料。社長が study_submit で出す */
const STUDY = "似た物: 3 つある。作る量: 2 か月。セキュリティ: 上げた動画を外に出さない";

/**
 * 案を検討の段階に移し、社長が調べた材料を出す
 * @param w テストの物
 * @param serviceId サービス ID
 */
async function studied(w: WorkWorld, serviceId: string): Promise<void> {
  await advance(w, serviceId, { to: "study", reason: "売り上げの見込みが大きい" });
  expect(await tool(w, "president", "study_submit", { serviceId, body: STUDY })).toMatchObject({ isError: false });
}

describe("アイデアから運用までの流れ", () => {
  it("案を足す", async () => {
    const owner = await ownerIdea(world);
    world.clock.advance(MINUTE);
    // 社員も案を足せる。足した社員が出来事に残る
    const made = await tool(world, "builder", "idea_add", { ...VIDEO, title: "記事を書くサービス", kind: "content" });
    expect(made.isError).toBe(false);
    const staff = idOf(JSON.parse(made.content));

    const ideas = z.array(Card).parse(await api(world, "GET", "/api/v1/services?stage=idea"));
    expect(ideas.map((s) => [s.id, s.name, s.kind, s.stage])).toEqual([
      [owner, "動画を作るサービス", "web_app", "idea"],
      [staff, "記事を書くサービス", "content", "idea"],
    ]);
    expect(z.array(Card).parse(await api(world, "GET", "/api/v1/services?stage=study"))).toEqual([]);
    const detail = await detailOf(world, owner);
    expect(detail).toMatchObject({ aim: VIDEO.aim, users: VIDEO.users, costEstimateMicroUsd: 30_000_000, revenueEstimateMicroUsd: 120_000_000, study: null, droppedReason: null });
    expect(detail.events.map((e) => [e.kind, e.by, e.detail["to"]])).toEqual([["stage", "owner", "idea"]]);
    expect((await detailOf(world, staff)).events.map((e) => e.by)).toEqual(["builder"]);
    expect(world.gate.audits.map((a) => a.action)).toContain("service.create");
  });

  it("検討の材料", async () => {
    const id = await ownerIdea(world);
    expect(Card.parse(await advance(world, id, { to: "study", reason: "売り上げの見込みが大きい" }))).toMatchObject({ id, stage: "study" });
    // 社長に調べるタスクが足される。アイデアの検討はどのサービスにも入らないので office の分
    const tasks = await rows(world.d1.DB, "SELECT title, body, task_kind, scope, status FROM nodes WHERE kind = 'task' AND assignee = 'president'");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "調べる: 動画を作るサービス", task_kind: "plan", scope: "office", status: "todo" });
    for (const point of ["似た物", "作る量", "セキュリティ", id]) expect(String(tasks[0]?.["body"])).toContain(point);

    // 社長が調べた材料を出すと、判断の材料として読める
    expect(await tool(world, "president", "study_submit", { serviceId: id, body: STUDY })).toMatchObject({ isError: false });
    expect((await detailOf(world, id)).study).toBe(STUDY);
    // 検討の段階でない案には材料を出せない
    const other = await ownerIdea(world);
    await expect(tool(world, "president", "study_submit", { serviceId: other, body: STUDY })).rejects.toMatchObject({ code: "conflict" });
  });

  it("見送る", async () => {
    const id = await ownerIdea(world);
    await studied(world, id);
    expect(Card.parse(await advance(world, id, { to: "dropped", reason: "似た物が安く出ている" }))).toMatchObject({ stage: "dropped" });
    // 理由と一緒に残り、後から読める
    const detail = await detailOf(world, id);
    expect(detail).toMatchObject({ stage: "dropped", droppedReason: "似た物が安く出ている", study: STUDY, aim: VIDEO.aim });
    expect(z.array(Card).parse(await api(world, "GET", "/api/v1/services?stage=dropped")).map((s) => s.id)).toEqual([id]);
    // 見送った案は先へ進めない
    expect(await advance(world, id, { to: "prototype", reason: "やはり作る", staffId: "builder" }, 409)).toMatchObject({ code: "conflict" });
    expect(world.gate.audits.filter((a) => a.action === "service.advance")).toHaveLength(2);
  });

  it("サービスから元の案をたどる", async () => {
    const id = await ownerIdea(world);
    await studied(world, id);
    // 作ると決める時に担当の社員を決める。決めずに進めると 422
    expect(await advance(world, id, { to: "prototype", reason: "作る" }, 422)).toMatchObject({ code: "validation_failed" });
    expect(Card.parse(await advance(world, id, { to: "prototype", reason: "作る", staffId: "builder" }))).toMatchObject({ stage: "prototype", staffId: "builder" });
    await advance(world, id, { to: "service", reason: "本番に出す" });
    // 段階を飛ばしては移れない
    expect(await advance(world, id, { to: "study", reason: "戻す" }, 409)).toMatchObject({ code: "conflict" });

    const detail = await detailOf(world, id);
    // サービスの元になった案と検討の材料が出る
    expect(detail).toMatchObject({ name: VIDEO.title, stage: "service", aim: VIDEO.aim, users: VIDEO.users, revenueEstimateMicroUsd: 120_000_000, study: STUDY });
    expect(detail.events.map((e) => [e.detail["to"], e.detail["reason"] ?? null])).toEqual([
      ["idea", null],
      ["study", "売り上げの見込みが大きい"],
      ["prototype", "作る"],
      ["service", "本番に出す"],
    ]);
    expect(await api(world, "GET", "/api/v1/services/0192f5c0-0000-7000-8000-000000000000", undefined, 404)).toMatchObject({ code: "not_found" });
  });
});

describe("段階ごとのオーナーの判断", () => {
  it("閉じる案", async () => {
    const id = await ownerIdea(world);
    await studied(world, id);
    await advance(world, id, { to: "prototype", reason: "作る", staffId: "builder" });
    await advance(world, id, { to: "service", reason: "本番に出す" });
    await advance(world, id, { to: "operation", reason: "運用に入る" });

    // 開発担当がタスクの途中で閉じる案を出す
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "運用" }, 201));
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "使われ方を見る", taskKind: "build", assignee: "builder", priority: 1 }, 201));
    await clockIn(world, "builder");
    await staffOf(world, "builder").pull(world.clock.now());
    expect(await tool(world, "builder", "service_close_request", { serviceId: id, reason: "半年使われていない" })).toMatchObject({ isError: false });

    // オーナーが決めるまでサービスは閉じない
    expect((await detailOf(world, id)).stage).toBe("operation");
    const [approval] = z.array(z.object({ id: z.string(), kind: z.string(), target: z.string(), payload: z.record(z.string(), z.unknown()) }).loose()).parse(await api(world, "GET", "/api/v1/approvals"));
    expect(approval).toMatchObject({ kind: "service_close", target: id, payload: { nodeId: task, reason: "半年使われていない" } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "waiting_owner" }]);
    // サービスか運用の段階でない案には閉じる案を出せない
    const idea = await ownerIdea(world);
    await expect(tool(world, "builder", "service_close_request", { serviceId: idea, reason: "要らない" })).rejects.toMatchObject({ code: "conflict" });

    // オーナーが承認すると閉じ、待っていたタスクは戻る
    await api(world, "POST", `/api/v1/approvals/${String(approval?.id)}/decision`, { decision: "approve", reason: "閉じてよい" });
    const closed = await detailOf(world, id);
    expect(closed.stage).toBe("closed");
    expect(closed.events.at(-1)).toMatchObject({ by: "owner", detail: { to: "closed", reason: "半年使われていない", approvalId: approval?.id } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "todo" }]);
  });

  it("差し戻した閉じる案ではサービスは変わらない", async () => {
    const id = await ownerIdea(world);
    await studied(world, id);
    await advance(world, id, { to: "prototype", reason: "作る", staffId: "builder" });
    await advance(world, id, { to: "service", reason: "本番に出す" });
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "運用" }, 201));
    await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "使われ方を見る", taskKind: "build", assignee: "builder", priority: 1 }, 201);
    await clockIn(world, "builder");
    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "service_close_request", { serviceId: id, reason: "使われていない" });
    const [approval] = z.array(z.object({ id: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/approvals"));
    await api(world, "POST", `/api/v1/approvals/${String(approval?.id)}/decision`, { decision: "reject", reason: "まだ続ける" });
    expect((await detailOf(world, id)).stage).toBe("service");
  });
});
