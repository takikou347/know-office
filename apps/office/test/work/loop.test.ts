// 目的からタスクまでの木とタスクの繰り返し。社長が分け、開発担当が取り、レビュー担当の承認で main に入るまで (タスクとレビューの 3.1)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { finishTask, intakeTask, pullNext, type TaskBook } from "../../src/gate/work/loop.ts";
import { createNode, findNode, recordsOf } from "../../src/gate/work/nodes.ts";
import { taskPrompt } from "../../src/gate/work/run.ts";
import { api, at, advance, clockIn, idOf, purposeAndGoal, REPO, rows, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/**
 * 社員が今持っているタスクを読む
 * @param w テストの物
 * @param staffId 社員 ID
 * @returns タスク ID。無ければ null
 */
async function doing(w: WorkWorld, staffId: "president" | "builder" | "reviewer"): Promise<string | null> {
  return (await w.gate.staff[staffId].book.status(w.clock.now())).nodeId;
}

const Versioned = z.object({ version: z.number() }).loose();

/**
 * オーナーが木の 1 件を変える。断られても投げず、ステータスを返す
 * @param w テストの物
 * @param nodeId ID
 * @param change 変える物
 * @returns ステータス
 */
async function ownerPatch(w: WorkWorld, nodeId: string, change: Record<string, unknown>): Promise<number> {
  const { version } = Versioned.parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  const res = await w.gate.request(`/api/v1/nodes/${nodeId}`, { method: "PATCH", headers: { ...w.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version, ...change }) });
  return res.status;
}

/**
 * 3 人を出勤させ、開発担当がプルリクエストを出し、レビュー担当がレビューのタスクを取るところまで進める
 * @param w テストの物
 * @returns 開発担当のタスクの ID
 */
async function openedPull(w: WorkWorld): Promise<string> {
  const { goal } = await purposeAndGoal(w);
  await clockIn(w, "president", "builder", "reviewer");
  await presidentPlans(w);
  const { tasks } = await split(w, goal, "勤怠の表をつなぐ");
  expect(await tool(w, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" })).toMatchObject({ isError: false });
  return String(tasks[0]);
}

const Titled = z.object({ id: z.string(), title: z.string(), kind: z.string(), status: z.string() }).loose();
type Tree = z.infer<typeof Titled> & { children: Tree[] };
const TreeSchema: z.ZodType<Tree> = Titled.extend({ children: z.lazy(() => z.array(TreeSchema)) });

/**
 * 社員が持つ todo と doing のタスクを読む
 * @param w テストの物
 * @param staffId 社員 ID
 * @returns タスクの名前、種類、状態
 */
function tasksOf(w: WorkWorld, staffId: string) {
  return rows(w.d1.DB, "SELECT title, task_kind, status FROM nodes WHERE kind = 'task' AND assignee = ? AND status IN ('todo', 'doing') ORDER BY created_at", staffId);
}

/**
 * 社長に次のタスクを作らせる
 * @param w テストの物
 * @returns 社長が取った plan のタスクの ID
 */
async function presidentPlans(w: WorkWorld): Promise<string> {
  // 開発担当の山が空なので社長に plan のタスクが足され、手の空いた社長がすぐに取る
  await staffOf(w, "builder").pull(w.clock.now());
  const [plan] = await rows(w.d1.DB, "SELECT id FROM nodes WHERE assignee = 'president' AND status = 'doing'");
  return z.string().parse(plan?.["id"]);
}

/**
 * 社長が目標の下にプロジェクトとタスクを作り、開発担当に割り振る
 * @param w テストの物
 * @param goal 目標の ID
 * @param titles タスクの名前
 * @returns プロジェクトとタスクの ID
 */
async function split(w: WorkWorld, goal: string, ...titles: string[]): Promise<{ project: string; tasks: string[] }> {
  const project = await tool(w, "president", "node_create", { kind: "project", parentId: goal, title: "勤怠を本物の記録で出す" });
  expect(project.isError).toBe(false);
  const projectId = z.object({ id: z.string() }).parse(JSON.parse(project.content)).id;
  const tasks: string[] = [];
  for (const [n, title] of titles.entries()) {
    const made = await tool(w, "president", "node_create", { kind: "task", parentId: projectId, title, taskKind: "build", repo: REPO, priority: 10 + n });
    const taskId = z.object({ id: z.string() }).parse(JSON.parse(made.content)).id;
    expect(await tool(w, "president", "node_assign", { nodeId: taskId, assignee: "builder" })).toMatchObject({ isError: false });
    tasks.push(taskId);
  }
  return { project: projectId, tasks };
}

describe("目的からタスクまでの木", () => {
  it("社長が目標をタスクに分ける", async () => {
    const { purpose, goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    const plan = await presidentPlans(world);
    const { project, tasks } = await split(world, goal, "勤怠の表をつなぐ");
    await finishTask(world.gate.env, "president", plan, world.clock.now());

    // 割り振られた時に手の空いていた開発担当は、すぐに取る
    expect(await doing(world, "builder")).toBe(tasks[0]);
    const detail = await api(world, "GET", `/api/v1/nodes/${String(tasks[0])}`);
    expect(detail).toMatchObject({ kind: "task", status: "doing", assignee: "builder", taskKind: "build" });
    expect(z.object({ ancestors: z.array(Titled) }).loose().parse(detail).ancestors.map((a) => [a.kind, a.id])).toEqual([
      ["purpose", purpose],
      ["goal", goal],
      ["project", project],
    ]);
    // 画面は木を 1 度に読み、目的からタスクまでたどる
    const trees = z.array(TreeSchema).parse(await api(world, "GET", `/api/v1/nodes?rootId=${purpose}`));
    expect(trees.map((t) => t.id)).toEqual([purpose]);
    expect(trees[0]?.children[0]?.children[0]?.children.map((t) => t.id)).toEqual(tasks);
  });

  it("途中からタスクを足す", async () => {
    // 走っていない社長への発言と GitHub の Issue は、受け付けのプロジェクトの下に社長が分けるタスクとして入る。発言のタスクは山の先頭に置く
    const sent = z.object({ id: z.string(), taskId: z.string() }).loose().parse(await api(world, "POST", "/api/v1/staff/president/messages", { body: "勤怠を週ごとにも見たい\n週の合計が欲しい" }, 201));
    const issue = await intakeTask(world.gate.env, { scope: "office", title: "ログインが遅い", body: "", source: "issue", issueNumber: 31 }, at(10, 5));
    const trees = z.array(TreeSchema).parse(await api(world, "GET", "/api/v1/nodes?scope=office"));
    expect(trees.find((t) => t.kind === "project")?.children.map((t) => [t.id, t.title, t.status])).toEqual([
      [sent.taskId, "勤怠を週ごとにも見たい", "todo"],
      [issue, "ログインが遅い", "todo"],
    ]);
    expect((await tasksOf(world, "president")).map((t) => [t["title"], t["task_kind"], t["status"]])).toEqual([["勤怠を週ごとにも見たい", "plan", "todo"], ["ログインが遅い", "plan", "todo"]]);
    const sources = await rows(world.d1.DB, "SELECT source, priority FROM nodes WHERE id IN (?, ?) ORDER BY priority", sent.taskId, issue);
    expect(sources).toEqual([{ source: `chat:${sent.id}`, priority: 0 }, { source: "issue", priority: 100 }]);
  });
});

describe("タスクの繰り返し", () => {
  it("山が空になる", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    expect(await staffOf(world, "builder").pull(world.clock.now())).toEqual({ taken: false, nodeId: null });
    // 何度求めても、社長の plan のタスクは 1 つだけ
    await staffOf(world, "builder").pull(world.clock.now());
    expect(await tasksOf(world, "president")).toEqual([{ title: "開発担当の次のタスクを作る", task_kind: "plan", status: "doing" }]);
    await advance(world, at(9, 30));
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "working", nodeId: tasks[0] });
  });

  it("タスクの流れ", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder", "reviewer");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ", "勤怠の訂正を出す");
    const [first = "", second = ""] = tasks;
    expect(await doing(world, "builder")).toBe(first);

    await advance(world, at(10));
    expect(await tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "テストを足した" })).toMatchObject({ isError: false });
    const branch = `ko/${first}`;
    expect(world.forge.pulls).toEqual([{ repo: REPO, branch, title: "勤怠の表をつなぐ" }]);
    expect(await rows(world.d1.DB, "SELECT status, branch, pr_number FROM nodes WHERE id = ?", first)).toEqual([{ status: "review", branch, pr_number: 1 }]);
    // 開発担当はプルリクエストを出したら次を取る
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ nodeId: second });
    // 手の空いていたレビュー担当は、足されたレビューのタスクをすぐに取る
    expect(await tasksOf(world, "reviewer")).toEqual([{ title: "レビュー: 勤怠の表をつなぐ", task_kind: "review", status: "doing" }]);
    await advance(world, at(10, 30));
    expect(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "テストと型を確かめた。未確認の所は無い", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    expect(world.forge.merged).toEqual([branch]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first)).toEqual([{ status: "done" }]);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict, reviewer_summary FROM reviews WHERE node_id = ?", first)).toEqual([
      { reviewer_verdict: "approve", reviewer_summary: "テストと型を確かめた。未確認の所は無い" },
    ]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE task_kind = 'review'")).toEqual([{ status: "done" }]);
  });
  it("タスクを取ると、リポジトリのあるタスクにブランチを決め、続けたタスクのブランチは変えない", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    const [first = ""] = tasks;
    expect(await doing(world, "builder")).toBe(first);
    expect(await rows(world.d1.DB, "SELECT status, branch FROM nodes WHERE id = ?", first)).toEqual([{ status: "doing", branch: `ko/${first}` }]);
    // 社員への最初の指示は、決めたブランチの名前をそのまま伝える
    expect(taskPrompt(await findNode(world.d1.DB, first))).toContain(`ブランチは ko/${first} で切り、push できるのはこのブランチだけ`);
    // リポジトリの無いタスク (社長の plan) にはブランチを決めない
    expect(await rows(world.d1.DB, "SELECT branch FROM nodes WHERE assignee = 'president' AND status = 'doing'")).toEqual([{ branch: null }]);
    // もうブランチのあるタスク (差し戻しで戻ったタスク、前の勤務から続けたタスク) は、取り直しても同じブランチのまま
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo', branch = 'ko/kept-branch' WHERE id = ?").bind(first).run();
    await world.gate.staff.builder.book.finish("handed_back", world.clock.now());
    await staffOf(world, "builder").pull(world.clock.now());
    expect(await rows(world.d1.DB, "SELECT status, branch FROM nodes WHERE id = ?", first)).toEqual([{ status: "doing", branch: "ko/kept-branch" }]);
    // doing のまま branch の無いタスクは、取り直しでブランチが決まる。版は doing への移しの 1 つだけ進み、ブランチの書き込みを別に増やさない
    await world.d1.DB.prepare("UPDATE nodes SET status = 'todo', branch = NULL, version = 10 WHERE id = ?").bind(first).run();
    await world.gate.staff.builder.book.finish("handed_back", world.clock.now());
    await staffOf(world, "builder").pull(world.clock.now());
    expect(await rows(world.d1.DB, "SELECT status, branch, version FROM nodes WHERE id = ?", first)).toEqual([{ status: "doing", branch: `ko/${first}`, version: 11 }]);
  });

  it("pr_open はタスクのブランチで PR を出す", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder", "reviewer");
    await presidentPlans(world);
    const [first = ""] = (await split(world, goal, "勤怠の表をつなぐ")).tasks;
    // 入力にブランチの名前は無い。name を付けると形の違いとして断る
    await expect(tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" })).rejects.toMatchObject({ code: "validation_failed" });
    // ブランチの無いタスクは、GitHub に出さずに断る
    await world.d1.DB.prepare("UPDATE nodes SET branch = NULL WHERE id = ?").bind(first).run();
    await expect(tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" })).rejects.toMatchObject({ code: "conflict" });
    expect(world.forge.pulls).toEqual([]);
    await world.d1.DB.prepare("UPDATE nodes SET branch = ? WHERE id = ?").bind(`ko/${first}`, first).run();
    expect(await tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" })).toMatchObject({ isError: false });
    expect(world.forge.pulls).toEqual([{ repo: REPO, branch: `ko/${first}`, title: "勤怠の表をつなぐ" }]);
    expect(await rows(world.d1.DB, "SELECT n.branch AS node, r.branch AS review FROM nodes n JOIN reviews r ON r.node_id = n.id WHERE n.id = ?", first)).toEqual([{ node: `ko/${first}`, review: `ko/${first}` }]);
  });
});

describe("タスクの繰り返しの決まり", () => {
  it("チェックが通るまで承認されても main に入れない", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder", "reviewer");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());
    world.forge.checks = "pending";
    await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ", headSha: "b".repeat(40) });
    expect(world.forge.merged).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", tasks[0])).toEqual([{ status: "review" }]);
    // 待っている間はチェックを通らないマージとして数えない
    expect(await rows(world.d1.DB, "SELECT signal FROM stops")).toEqual([]);
  });

  it("要るチェックが落ちたまま承認されると、main に入れずにそのタスクを止める", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder", "reviewer");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());
    world.forge.checks = "failed";
    await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ", headSha: "b".repeat(40) });
    expect(world.forge.merged).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT scope, target, signal FROM stops")).toEqual([{ scope: "task", target: tasks[0], signal: "unchecked_merge" }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", tasks[0])).toEqual([{ status: "stopped" }]);
    expect(await rows(recordsOf(world.gate.env, world.clock.now()), "SELECT kind, detail FROM node_events WHERE node_id = ? AND kind LIKE 'merge%'", tasks[0])).toEqual([{ kind: "merge_refused", detail: JSON.stringify({ reason: "checks" }) }]);
  });

  it("階層に合わない親は 409、無い親は 404 で断る", async () => {
    const { purpose } = await purposeAndGoal(world);
    expect(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: purpose, scope: "office", title: "飛ばした", taskKind: "build" }, 409)).toMatchObject({ code: "conflict" });
    expect(await api(world, "POST", "/api/v1/nodes", { kind: "goal", parentId: "0190f4a8-0000-7000-8000-00000000ffff", scope: "office", title: "親が無い" }, 404)).toMatchObject({ code: "not_found" });
    expect(await api(world, "POST", "/api/v1/nodes", { kind: "goal", scope: "office", title: "親を付けない" }, 409)).toMatchObject({ code: "conflict" });
    expect(await api(world, "POST", "/api/v1/nodes", { kind: "purpose", scope: "office", title: "目的に担当", assignee: "builder" }, 422)).toMatchObject({ code: "validation_failed" });
  });

  it("バージョンが違う変更と、作った社員と同じモデルのレビュー担当への割り振りを断る", async () => {
    const { goal } = await purposeAndGoal(world);
    // レビュー担当は出勤させず、レビューのタスクを todo のまま残す
    await clockIn(world, "president", "builder");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    const first = String(tasks[0]);
    const before = z.object({ version: z.number() }).loose().parse(await api(world, "GET", `/api/v1/nodes/${first}`));
    expect(await api(world, "PATCH", `/api/v1/nodes/${first}`, { version: before.version, priority: 1 })).toMatchObject({ priority: 1, version: before.version + 1 });
    expect(await api(world, "PATCH", `/api/v1/nodes/${first}`, { version: before.version, priority: 2 }, 409)).toMatchObject({ detail: "バージョンが違う" });

    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" });
    const [review] = await rows(world.d1.DB, "SELECT id, version FROM nodes WHERE task_kind = 'review'");
    // 開発担当 (Sonnet) が作った物を開発担当に確かめさせない
    expect(await api(world, "PATCH", `/api/v1/nodes/${String(review?.["id"])}`, { version: review?.["version"], assignee: "builder" }, 409)).toMatchObject({
      detail: "作った社員と同じモデルには確かめさせない",
    });
  });

  it("社員の役で使えないツールは not_found で断る", async () => {
    await expect(tool(world, "builder", "node_create", { kind: "project", parentId: "0190f4a8-0000-7000-8000-00000000ffff", title: "勝手に作る" })).rejects.toMatchObject({ code: "not_found" });
    await expect(tool(world, "reviewer", "pr_open", { title: "x", body: "" })).rejects.toMatchObject({ code: "not_found" });
    await expect(tool(world, "president", "no_such_tool", {})).rejects.toMatchObject({ code: "not_found" });
  });

  it("オーナーが作業中でない社員にタスクを割り振ると、勤務時間外なら呼び出す", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "急ぎ" }, 201));
    await advance(world, at(21));
    world.headers = await world.gate.signIn();
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "急ぎの直し", taskKind: "fix", assignee: "builder" }, 201));
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "called", nodeId: task });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
  });

  it("社員 DO が呼び出しを断ったら、頼んだタスクを todo に戻す", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "急ぎ" }, 201));
    await advance(world, at(21));
    world.headers = await world.gate.signIn();
    // 状態を読んだ後に、ほかの道で出勤していた時と同じく、社員 DO が呼び出さない
    world.gate.staff.builder.book.call = () => Promise.resolve(false);
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "急ぎの直し", taskKind: "fix", assignee: "builder" }, 201));
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "todo" }]);
  });

  it("取る間に担当が変わったタスクを 2 人で取らない", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    await clockIn(world, "president", "builder");
    // 知らせずに置き、開発担当が取る途中でオーナーが担当を社長に変える
    const task = (await createNode(world.gate.env, { kind: "task", parentId: project, scope: "office", title: "勤怠の表をつなぐ", taskKind: "build", assignee: "builder" }, { by: "owner", now: world.clock.now() })).id;
    const book = world.gate.staff.builder.book;
    const racing: TaskBook = {
      staffId: "builder",
      status: (now) => book.status(now),
      take: async (t, median, now) => {
        await ownerPatch(world, task, { assignee: "president" });
        return book.take(t, median, now);
      },
    };
    await pullNext(world.gate.env, racing, world.clock.now());

    const holders = [await doing(world, "builder"), await doing(world, "president")].filter((id) => id === task);
    expect(holders).toHaveLength(1);
    const [row] = await rows(world.d1.DB, "SELECT status, assignee FROM nodes WHERE id = ?", task);
    expect(row?.["status"]).toBe("doing");
    expect(await doing(world, z.enum(["president", "builder"]).parse(row?.["assignee"]))).toBe(task);
  });

  it("プルリクエストを出す間にタスクの名前が変わっても、レビューに回す", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    const first = String(tasks[0]);
    world.forge.during.openPull = async () => {
      expect(await ownerPatch(world, first, { title: "勤怠の表を本物の記録につなぐ" })).toBe(200);
    };
    expect(await tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" })).toMatchObject({ isError: false });
    expect(await rows(world.d1.DB, "SELECT status, pr_number FROM nodes WHERE id = ?", first)).toEqual([{ status: "review", pr_number: 1 }]);
    expect(await rows(world.d1.DB, "SELECT assignee, status FROM nodes WHERE task_kind = 'review'")).toEqual([{ assignee: "reviewer", status: "todo" }]);
  });

  it("作った社員と同じモデルのレビュー担当しかいない時は、プルリクエストを出さない", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    await world.d1.DB.prepare("UPDATE staff SET model = (SELECT model FROM staff WHERE id = 'builder') WHERE id = 'reviewer'").run();
    await expect(tool(world, "builder", "pr_open", { title: "勤怠の表をつなぐ", body: "" })).rejects.toMatchObject({ code: "conflict" });
    expect(world.forge.pulls).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", tasks[0])).toEqual([{ status: "doing" }]);
    expect(await doing(world, "builder")).toBe(tasks[0]);
    expect(await rows(world.d1.DB, "SELECT id FROM nodes WHERE task_kind = 'review'")).toEqual([]);
  });

  it("見送ったタスクは、承認されても main に入れない", async () => {
    const first = await openedPull(world);
    expect(await ownerPatch(world, first, { status: "dropped" })).toBe(200);
    await expect(tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ", headSha: "b".repeat(40) })).rejects.toMatchObject({ code: "conflict" });
    expect(world.forge.merged).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first)).toEqual([{ status: "dropped" }]);
  });

  it("main に入れる間にタスクが変わっても、入れたタスクは done にする", async () => {
    const first = await openedPull(world);
    world.forge.during.merge = async () => {
      await ownerPatch(world, first, { title: "勤怠の表を本物の記録につなぐ" });
    };
    expect(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    expect(world.forge.merged).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first)).toEqual([{ status: "done" }]);
  });

  it("作った社員が分からないレビューのタスクは、誰にも割り振らない", async () => {
    const first = await openedPull(world);
    const [review] = await rows(world.d1.DB, "SELECT id FROM nodes WHERE task_kind = 'review'");
    const reviewId = String(review?.["id"]);
    await world.d1.DB.prepare("UPDATE nodes SET assignee = NULL WHERE id = ?").bind(first).run();
    expect(await ownerPatch(world, reviewId, { assignee: "reviewer" })).toBe(409);

    // リポジトリとプルリクエストの無いレビューのタスクも、作った物をたどれないので断る
    const [made] = await rows(world.d1.DB, "SELECT parent_id FROM nodes WHERE id = ?", first);
    const bare = (await createNode(world.gate.env, { kind: "task", parentId: String(made?.["parent_id"]), scope: "office", title: "レビュー: 手で足した", taskKind: "review" }, { by: "system", now: world.clock.now() })).id;
    expect(await ownerPatch(world, bare, { assignee: "reviewer" })).toBe(409);
  });
});
