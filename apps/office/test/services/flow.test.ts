// アイデアから運用までの流れ。案を足し、社長が調べ、オーナーが段階ごとに決め、サービスから元の案をたどる (サービスと拡張の 3.1)
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { connect } from "../helpers/github.ts";
import { api, clockIn, idOf, MINUTE, purposeAndGoal, rows, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

// 作ると決める時にリポジトリを選ぶので、代わりの GitHub につなぐ
const world = useWork({ github: true });

// 差し替えたバインディングを、テストごとに元へ戻す
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/**
 * ゲートウェイの D1 か R2 の 1 つのメソッドの、次の呼び出しの直前に、ほかの要求を挟む。読んだ後に書くまでの間の、同時の変更の代わり
 * @param w テストの物
 * @param binding 差し替えるバインディング
 * @param method 挟むメソッド
 * @param action 挟む動き。動かす間は元のバインディングに戻す
 */
function beforeNext(w: WorkWorld, binding: "DB" | "FILES", method: string, action: () => Promise<unknown>): void {
  const env = w.gate.env;
  const original = env[binding];
  const restore = () => {
    Object.assign(env, { [binding]: original });
  };
  restores.push(restore);
  // wrangler の手元のバインディングは差し替えを受けないので、要求が読む env の側を包む
  const wrapped = new Proxy(original, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop !== method) {
        const bound: unknown = value.bind(target);
        return bound;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        restore();
        await action();
        const out: unknown = Reflect.apply(value, target, args);
        return out;
      };
    },
  });
  Object.assign(env, { [binding]: wrapped });
}

/**
 * 次の D1 の batch の直前に、ほかの要求を挟む
 * @param w テストの物
 * @param action 挟む動き
 */
function beforeNextBatch(w: WorkWorld, action: () => Promise<unknown>): void {
  beforeNext(w, "DB", "batch", action);
}

/**
 * サービスの段階を直に書き換える。オーナーがほかの画面で移した事の代わり
 * @param w テストの物
 * @param serviceId サービス ID
 * @param stage 段階
 */
async function setStage(w: WorkWorld, serviceId: string, stage: string): Promise<void> {
  await w.d1.DB.prepare("UPDATE services SET stage = ? WHERE id = ?").bind(stage, serviceId).run();
}

const Card = z.object({ id: z.string(), name: z.string(), kind: z.string(), stage: z.string(), staffId: z.string().nullable(), repo: z.string().nullable() }).strict();
const Detail = Card.extend({
  aim: z.string(),
  users: z.string(),
  costEstimateMicroUsd: z.number(),
  revenueEstimateMicroUsd: z.number(),
  study: z.string().nullable(),
  droppedReason: z.string().nullable(),
  status: z.object({ kind: z.string() }).loose(),
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

/**
 * 作ると決める。まだなら GitHub とつなぎ、触れるリポジトリを選ぶ
 * @param w テストの物
 * @param serviceId サービス ID
 * @param status 待つステータス
 * @returns 返った data
 */
async function toPrototype(w: WorkWorld, serviceId: string, status = 200): Promise<unknown> {
  if ((await rows(w.d1.DB, "SELECT 1 FROM vault WHERE name = 'github_installation' AND revoked_at IS NULL")).length === 0) await connect(w);
  return advance(w, serviceId, { to: "prototype", reason: "作る", staffId: "builder", repo: "example/know-office" }, status);
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

  describe("検討の材料の境目", () => {
    it("調べるタスクを足せなければ、段階も検討に移らない", async () => {
      const id = await ownerIdea(world);
      // 調べるタスクの書き込みだけを断る
      await world.d1.DB.prepare("CREATE TRIGGER study_task_fails BEFORE INSERT ON nodes WHEN NEW.source LIKE 'study:%' BEGIN SELECT RAISE(ABORT, 'test'); END").run();
      try {
        await advance(world, id, { to: "study", reason: "調べる" }, 500);
      } finally {
        await world.d1.DB.prepare("DROP TRIGGER study_task_fails").run();
      }
      expect((await detailOf(world, id)).stage).toBe("idea");
      expect((await detailOf(world, id)).events.map((e) => e.detail["to"])).toEqual(["idea"]);
      // 直った後に移し直すと、調べるタスクが 1 つだけ足される
      await advance(world, id, { to: "study", reason: "調べる" });
      expect(await rows(world.d1.DB, "SELECT title FROM nodes WHERE kind = 'task' AND assignee = 'president'")).toEqual([{ title: "調べる: 動画を作るサービス" }]);
    });

    it("同時に検討に移すと、片方は 409 で、調べるタスクは 1 つ", async () => {
      const id = await ownerIdea(world);
      beforeNextBatch(world, () => advance(world, id, { to: "study", reason: "先に移す" }));
      expect(await advance(world, id, { to: "study", reason: "後から移す" }, 409)).toMatchObject({ code: "conflict" });
      expect(await rows(world.d1.DB, "SELECT title FROM nodes WHERE kind = 'task' AND assignee = 'president'")).toEqual([{ title: "調べる: 動画を作るサービス" }]);
    });

    it("2 度目に出した材料に替わり、出す間に検討の段階でなくなった材料は捨てる", async () => {
      const id = await ownerIdea(world);
      await studied(world, id);
      await tool(world, "president", "study_submit", { serviceId: id, body: "直した材料" });
      expect((await detailOf(world, id)).study).toBe("直した材料");
      // 出している間にオーナーが見送ると、出した材料は置かず、前の材料が残る
      beforeNext(world, "FILES", "put", () => setStage(world, id, "dropped"));
      await expect(tool(world, "president", "study_submit", { serviceId: id, body: "遅れた材料" })).rejects.toMatchObject({ code: "conflict" });
      expect((await detailOf(world, id)).study).toBe("直した材料");
      const listed = await world.gate.env.FILES.list({ prefix: `studies/${id}/` });
      expect(listed.objects).toHaveLength(2);
    });
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
    expect(await advance(world, id, { to: "prototype", reason: "やはり作る", staffId: "builder", repo: "example/know-office" }, 409)).toMatchObject({ code: "conflict" });
    expect(world.gate.audits.filter((a) => a.action === "service.advance")).toHaveLength(2);
  });

  it("サービスから元の案をたどる", async () => {
    const id = await ownerIdea(world);
    await studied(world, id);
    // 作ると決める時に担当の社員とリポジトリを決める。決めずに進めると 422
    expect(await advance(world, id, { to: "prototype", reason: "作る" }, 422)).toMatchObject({ code: "validation_failed" });
    expect(Card.parse(await toPrototype(world, id))).toMatchObject({ stage: "prototype", staffId: "builder", repo: "example/know-office" });
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

/**
 * 案をサービスの段階まで進め、開発担当がタスクの途中で閉じる案を出す
 * @param w テストの物
 * @param operation 運用の段階まで進めるか
 * @returns サービス ID、承認 ID、待っているタスクの ID
 */
async function closeRequested(w: WorkWorld, operation: boolean): Promise<{ id: string; approvalId: string; task: string }> {
  const id = await ownerIdea(w);
  await studied(w, id);
  await toPrototype(w, id);
  await advance(w, id, { to: "service", reason: "本番に出す" });
  if (operation) await advance(w, id, { to: "operation", reason: "運用に入る" });
  const { goal } = await purposeAndGoal(w);
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "運用" }, 201));
  const task = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "使われ方を見る", taskKind: "build", assignee: "builder", priority: 1 }, 201));
  await clockIn(w, "builder");
  await staffOf(w, "builder").pull(w.clock.now());
  expect(await tool(w, "builder", "service_close_request", { serviceId: id, reason: "半年使われていない" })).toMatchObject({ isError: false });
  const [approval] = z.array(z.object({ id: z.string() }).loose()).parse(await api(w, "GET", "/api/v1/approvals"));
  return { id, approvalId: String(approval?.id), task };
}

/**
 * 承認の状態を読む
 * @param w テストの物
 * @param approvalId 承認 ID
 * @returns 状態
 */
async function approvalStatus(w: WorkWorld, approvalId: string): Promise<unknown> {
  return (await rows(w.d1.DB, "SELECT status FROM approvals WHERE id = ?", approvalId))[0]?.["status"];
}

describe("段階ごとのオーナーの判断", () => {
  it("閉じる案", async () => {
    const { id, approvalId, task } = await closeRequested(world, true);
    // オーナーが決めるまでサービスは閉じない
    expect((await detailOf(world, id)).stage).toBe("operation");
    const [approval] = z.array(z.object({ id: z.string(), kind: z.string(), target: z.string(), payload: z.record(z.string(), z.unknown()) }).loose()).parse(await api(world, "GET", "/api/v1/approvals"));
    expect(approval).toMatchObject({ id: approvalId, kind: "service_close", target: id, payload: { nodeId: task, reason: "半年使われていない" } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "waiting_owner" }]);
    // サービスか運用の段階でない案には閉じる案を出せない
    const idea = await ownerIdea(world);
    await expect(tool(world, "builder", "service_close_request", { serviceId: idea, reason: "要らない" })).rejects.toMatchObject({ code: "conflict" });

    // オーナーが承認すると閉じ、待っていたタスクは戻る
    await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "閉じてよい" });
    const closed = await detailOf(world, id);
    expect(closed.stage).toBe("closed");
    expect(closed.events.at(-1)).toMatchObject({ by: "owner", detail: { to: "closed", reason: "半年使われていない", approvalId } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "todo" }]);
  });

  describe("閉じる案の境目", () => {
    it("差し戻した閉じる案ではサービスは変わらない", async () => {
      const { id, approvalId } = await closeRequested(world, false);
      await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "reject", reason: "まだ続ける" });
      expect((await detailOf(world, id)).stage).toBe("service");
    });

    it("承認を待つ間にサービスの段階が変わったら 409 で、承認は pending のまま", async () => {
      const { id, approvalId } = await closeRequested(world, false);
      // 承認を読んだ後、書くまでの間にオーナーがほかの画面で運用に移す
      beforeNextBatch(world, () => setStage(world, id, "operation"));
      expect(await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "閉じてよい" }, 409)).toMatchObject({ code: "conflict" });
      expect(await approvalStatus(world, approvalId)).toBe("pending");
      expect((await detailOf(world, id)).stage).toBe("operation");
      // 読み直して決め直せば閉じる
      await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "閉じてよい" });
      expect((await detailOf(world, id)).stage).toBe("closed");
    });

    it("同じ承認を 2 回決めると 2 回目は 409", async () => {
      const { id, approvalId } = await closeRequested(world, true);
      await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "閉じてよい" });
      expect(await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "approve", reason: "もう一度" }, 409)).toMatchObject({ code: "conflict" });
      const closed = await detailOf(world, id);
      expect(closed.events.filter((e) => e.detail["to"] === "closed")).toHaveLength(1);
      expect(await approvalStatus(world, approvalId)).toBe("approved");
    });

    it("レビュー担当は閉じる案を出せない", async () => {
      const id = await ownerIdea(world);
      await expect(tool(world, "reviewer", "service_close_request", { serviceId: id, reason: "要らない" })).rejects.toMatchObject({ code: "not_found" });
      // 案を足すのはできる
      expect(await tool(world, "reviewer", "idea_add", { ...VIDEO, title: "レビューを速くするサービス" })).toMatchObject({ isError: false });
    });
  });
});
