// 目的からタスクまでの木とタスクの繰り返し。社長が分け、開発担当が取り、レビュー担当の承認で main に入るまで (タスクとレビューの 3.1)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { finishTask, intakeTask } from "../../src/gate/work/loop.ts";
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
    // オーナーの発言と GitHub の Issue は、受け付けのプロジェクトの下に社長が分けるタスクとして入る
    const said = await intakeTask(world.gate.env, { scope: "office", title: "勤怠を週ごとにも見たい", body: "週の合計が欲しい", source: "chat" }, at(10));
    const issue = await intakeTask(world.gate.env, { scope: "office", title: "ログインが遅い", body: "", source: "issue", issueNumber: 31 }, at(10, 5));
    const trees = z.array(TreeSchema).parse(await api(world, "GET", "/api/v1/nodes?scope=office"));
    const intake = trees.find((t) => t.kind === "project");
    expect(intake?.children.map((t) => [t.id, t.title, t.status])).toEqual([
      [said, "勤怠を週ごとにも見たい", "todo"],
      [issue, "ログインが遅い", "todo"],
    ]);
    expect(await tasksOf(world, "president")).toEqual([
      { title: "勤怠を週ごとにも見たい", task_kind: "plan", status: "todo" },
      { title: "ログインが遅い", task_kind: "plan", status: "todo" },
    ]);
    expect(await rows(world.d1.DB, "SELECT source, issue_number FROM nodes WHERE id = ?", issue)).toEqual([{ source: "issue", issue_number: 31 }]);
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
    expect(await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "テストを足した" })).toMatchObject({ isError: false });
    const branch = `ko/${first.slice(0, 8)}-attendance-table`;
    expect(world.forge.pulls).toEqual([{ repo: REPO, branch, title: "勤怠の表をつなぐ" }]);
    expect(await rows(world.d1.DB, "SELECT status, branch, pr_number FROM nodes WHERE id = ?", first)).toEqual([{ status: "review", branch, pr_number: 1 }]);
    // 開発担当はプルリクエストを出したら次を取る
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ nodeId: second });
    // 手の空いていたレビュー担当は、足されたレビューのタスクをすぐに取る
    expect(await tasksOf(world, "reviewer")).toEqual([{ title: "レビュー: 勤怠の表をつなぐ", task_kind: "review", status: "doing" }]);
    await advance(world, at(10, 30));
    expect(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "テストと型を確かめた。未確認の所は無い" })).toMatchObject({ isError: false });
    expect(world.forge.merged).toEqual([branch]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first)).toEqual([{ status: "done" }]);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict, reviewer_summary FROM reviews WHERE node_id = ?", first)).toEqual([
      { reviewer_verdict: "approve", reviewer_summary: "テストと型を確かめた。未確認の所は無い" },
    ]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE task_kind = 'review'")).toEqual([{ status: "done" }]);
  });
});

describe("タスクの繰り返しの決まり", () => {
  it("チェックが通るまで承認されても main に入れない", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president", "builder", "reviewer");
    await presidentPlans(world);
    const { tasks } = await split(world, goal, "勤怠の表をつなぐ");
    await staffOf(world, "builder").pull(world.clock.now());
    await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());
    world.forge.checks = false;
    await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ" });
    expect(world.forge.merged).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", tasks[0])).toEqual([{ status: "review" }]);
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
    await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
    const [review] = await rows(world.d1.DB, "SELECT id, version FROM nodes WHERE task_kind = 'review'");
    // 開発担当 (Sonnet) が作った物を開発担当に確かめさせない
    expect(await api(world, "PATCH", `/api/v1/nodes/${String(review?.["id"])}`, { version: review?.["version"], assignee: "builder" }, 409)).toMatchObject({
      detail: "作った社員と同じモデルには確かめさせない",
    });
  });

  it("社員の役で使えないツールは not_found で断る", async () => {
    await expect(tool(world, "builder", "node_create", { kind: "project", parentId: "0190f4a8-0000-7000-8000-00000000ffff", title: "勝手に作る" })).rejects.toMatchObject({ code: "not_found" });
    await expect(tool(world, "reviewer", "pr_open", { name: "x", title: "x", body: "" })).rejects.toMatchObject({ code: "not_found" });
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
});
