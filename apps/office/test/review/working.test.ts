// プルリクエストを出す前のブランチ (作業中の変更) をレビューの画面で読む。ブランチはタスクを取った時に決まり、ゲートウェイが GitHub の ref と compare から読む (タスクとレビューの 3.2)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connect, stepUp } from "../helpers/github.ts";
import { openReview } from "../helpers/review.ts";
import { api, clockIn, idOf, purposeAndGoal, REPO, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/** 既定のブランチの先 */
const MAIN = "c".repeat(40);
/** 作業中のブランチの先 */
const WORK = "d".repeat(40);
/** 既定のブランチと作業中のブランチの共通の祖先 */
const MERGE_BASE = "a".repeat(40);
/** 一覧を読んだ後に push された先 */
const NEXT = "e".repeat(40);

const PATCH = "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;";

const Head = z
  .object({
    nodeId: z.string(),
    repo: z.string(),
    prNumber: z.number().nullable(),
    branch: z.string(),
    baseSha: z.string().nullable(),
    headSha: z.string().nullable(),
    lastSeenSha: z.string().nullable(),
    working: z.boolean(),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
    reviewerSummary: z.string(),
    reviewerVerdict: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), status: z.string(), seen: z.boolean() })),
  })
  .strict();
const Problem = z.object({ code: z.string() }).loose();

/**
 * GitHub につなぎ、開発担当にリポジトリのあるタスクを取らせる。PR はまだ出さない
 * @param w テストの物
 * @returns タスク ID とブランチ
 */
async function workingTask(w: WorkWorld): Promise<{ task: string; branch: string }> {
  await connect(w);
  const { goal } = await purposeAndGoal(w);
  await clockIn(w, "president", "builder");
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
  const task = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "勤怠の表をつなぐ", taskKind: "build", assignee: "builder", repo: REPO }, 201));
  await staffOf(w, "builder").pull(w.clock.now());
  return { task, branch: `ko/${task}` };
}

/**
 * 社員がブランチに push した後の GitHub を置く。既定のブランチの先、ブランチの先、2 つの間の compare
 * @param w テストの物
 * @param branch ブランチ
 * @param files compare が返すファイル
 */
function pushed(w: WorkWorld, branch: string, files: { filename: string; status: string; patch?: string }[]): void {
  w.gate.github.branchHeads.set("main", MAIN);
  w.gate.github.branchHeads.set(branch, WORK);
  w.gate.github.mergeBases.set(`${MAIN}...${WORK}`, MERGE_BASE);
  w.gate.github.compares.set(`${MAIN}...${WORK}`, files);
}

/**
 * GitHub への要求の道を、リポジトリの後ろだけにして並べる
 * @param w テストの物
 * @returns 「メソッド 道」
 */
function githubReads(w: WorkWorld): string[] {
  return w.gate.github.requests.filter((r) => r.route.startsWith(`GET /repos/${REPO}`)).map((r) => r.route.replace(`/repos/${REPO}`, ""));
}

/**
 * ゲートウェイに要求を送り、ステータスと code を返す
 * @param w テストの物
 * @param method メソッド
 * @param path 道
 * @param body 本文
 * @returns ステータスと code
 */
async function refused(w: WorkWorld, method: string, path: string, body?: unknown): Promise<{ status: number; code: string }> {
  const res = await w.gate.request(path, { method, headers: { ...w.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, code: Problem.parse(await res.json()).code };
}

describe("know-office の中で確認する", () => {
  it("作業中の変更を見る", async () => {
    const { task, branch } = await workingTask(world);
    pushed(world, branch, [{ filename: "src/a.ts", status: "modified", patch: PATCH }, { filename: "src/b.ts", status: "added" }]);
    const before = world.gate.github.requests.length;
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    expect(head).toEqual({
      nodeId: task,
      repo: REPO,
      prNumber: null,
      branch,
      baseSha: MERGE_BASE,
      headSha: WORK,
      lastSeenSha: null,
      working: true,
      checks: [],
      reviewerSummary: "",
      reviewerVerdict: null,
      files: [
        { path: "src/a.ts", status: "modified", seen: false },
        { path: "src/b.ts", status: "added", seen: false },
      ],
    });
    // 開くたびに読むのは、ブランチの先、既定のブランチ (リポジトリと先)、compare の 1 回ずつ
    expect(world.gate.github.requests.slice(before).filter((r) => r.route.startsWith(`GET /repos/${REPO}`)).map((r) => r.route.replace(`/repos/${REPO}`, "")).toSorted()).toEqual(["GET ", `GET /compare/${MAIN}...${WORK}`, `GET /git/ref/heads/${branch}`, "GET /git/ref/heads/main"].toSorted());
    // 差分は一覧が返した元と先で読む
    world.gate.github.compares.set(`${MERGE_BASE}...${WORK}`, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    const diff = await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&baseSha=${MERGE_BASE}&headSha=${WORK}`);
    expect(diff).toEqual({ path: "src/a.ts", language: "typescript", hunks: [{ oldStart: 1, newStart: 1, lines: ["-const a = 1;", "+const a = 2;"] }] });
  });

  it("作業中の変更は、承認、指摘、その場の直し、読んだ印を 409 で断る", async () => {
    const { task, branch } = await workingTask(world);
    pushed(world, branch, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    const before = world.gate.github.requests.length;
    expect({
      verdict: await refused(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: WORK }),
      notes: await refused(world, "POST", `/api/v1/reviews/${task}/notes`, { path: "src/a.ts", line: 1, side: "new", body: "ここ" }),
      commits: await refused(world, "POST", `/api/v1/reviews/${task}/commits`, { path: "src/a.ts", content: "x", baseSha: WORK, message: "直す" }),
      seen: await refused(world, "PUT", `/api/v1/reviews/${task}/seen`, { sha: WORK }),
    }).toEqual({ verdict: { status: 409, code: "conflict" }, notes: { status: 409, code: "conflict" }, commits: { status: 409, code: "conflict" }, seen: { status: 409, code: "conflict" } });
    // GitHub には何も送らず、タスクも動かさない
    expect(world.gate.github.requests.slice(before)).toEqual([]);
    expect((await world.d1.DB.prepare("SELECT status FROM nodes WHERE id = ?").bind(task).first())?.["status"]).toBe("doing");
  });

  it("まだ push の無い作業中のタスクは、空の変更を返す", async () => {
    const { task, branch } = await workingTask(world);
    // GitHub はまだ無いブランチの ref を 404 で返す
    world.gate.github.failNext(`GET /repos/${REPO}/git/ref/heads/${branch}`, 404);
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    expect(head).toMatchObject({ prNumber: null, branch, baseSha: null, headSha: null, working: true, files: [] });
    expect(githubReads(world).filter((r) => r.includes("/compare/"))).toEqual([]);
  });

  it("作業中の差分とファイルは、一覧が返した先を読み、since は 400", async () => {
    const { task, branch } = await workingTask(world);
    pushed(world, branch, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    // 一覧を読んだ後に push があっても、差分とファイルは一覧の元と先を読む
    world.gate.github.branchHeads.set(branch, NEXT);
    world.gate.github.compares.set(`${MERGE_BASE}...${WORK}`, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    world.gate.github.contents.set(`${WORK}:src/a.ts`, "const a = 2;\n");
    world.gate.github.contents.set(`${MERGE_BASE}:src/a.ts`, "const a = 1;\n");
    const query = `baseSha=${String(head.baseSha)}&headSha=${String(head.headSha)}`;
    expect(await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&${query}`)).toMatchObject({ path: "src/a.ts" });
    expect(await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=head&${query}`)).toEqual({ path: "src/a.ts", ref: WORK, content: "const a = 2;\n" });
    expect(await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=base&${query}`)).toEqual({ path: "src/a.ts", ref: MERGE_BASE, content: "const a = 1;\n" });
    expect(githubReads(world).filter((r) => r.includes(NEXT))).toEqual([]);
    // 作業中は元と先が要り、前に見た所からの差は無い
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts`)).toEqual({ status: 400, code: "malformed_request" });
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=head`)).toEqual({ status: 400, code: "malformed_request" });
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&${query}&since=${WORK}`)).toEqual({ status: 400, code: "malformed_request" });
    // 元と先は 40 字の 16 進数だけ
    expect((await refused(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&baseSha=main&headSha=${WORK}`)).status).toBe(422);
  });

  it("作業中の compare が 300 件ちょうどなら、一覧も差分も 502", async () => {
    const { task, branch } = await workingTask(world);
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${String(i)}.ts`, status: "added" }));
    pushed(world, branch, many);
    world.gate.github.compares.set(`${MERGE_BASE}...${WORK}`, many);
    expect(await refused(world, "GET", `/api/v1/reviews/${task}`)).toEqual({ status: 502, code: "upstream_failed" });
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Ff0.ts&baseSha=${MERGE_BASE}&headSha=${WORK}`)).toEqual({ status: 502, code: "upstream_failed" });
    // 299 件なら読める
    pushed(world, branch, many.slice(0, 299));
    expect(Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`)).files).toHaveLength(299);
  });

  it("触れないリポジトリの作業中の変更は読まない", async () => {
    const { task, branch } = await workingTask(world);
    pushed(world, branch, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    // 触れるリポジトリを knowidea-ui に絞る。非公開なのでルールセットは掛けない
    const UI = "example/knowidea-ui";
    await stepUp(world);
    world.gate.github.set(`GET /repos/${UI}`, { private: true, default_branch: "main" });
    await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos: [UI], reason: "knowidea-ui だけ" });
    const before = world.gate.github.requests.length;
    expect(await refused(world, "GET", `/api/v1/reviews/${task}`)).toEqual({ status: 403, code: "rule_denied" });
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&baseSha=${MERGE_BASE}&headSha=${WORK}`)).toEqual({ status: 403, code: "rule_denied" });
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=head&baseSha=${MERGE_BASE}&headSha=${WORK}`)).toEqual({ status: 403, code: "rule_denied" });
    expect(world.gate.github.requests.slice(before)).toEqual([]);
  });

  it("PR も作業中のブランチも無いタスクは 404", async () => {
    await connect(world);
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    // リポジトリの無いタスクと、まだ誰も取っていないタスク
    const plain = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "考える", taskKind: "build" }, 201));
    const untaken = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "まだ", taskKind: "build", repo: REPO }, 201));
    expect(await refused(world, "GET", `/api/v1/reviews/${plain}`)).toEqual({ status: 404, code: "not_found" });
    expect(await refused(world, "GET", `/api/v1/reviews/${untaken}`)).toEqual({ status: 404, code: "not_found" });
    expect(await refused(world, "GET", `/api/v1/reviews/${project}`)).toEqual({ status: 404, code: "not_found" });
  });

  it("レビューの行のある変更に baseSha と headSha を付けると 400", async () => {
    const { task } = await openReview(world);
    const range = `baseSha=${MERGE_BASE}&headSha=${WORK}`;
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&${range}`)).toEqual({ status: 400, code: "malformed_request" });
    expect(await refused(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=head&${range}`)).toEqual({ status: 400, code: "malformed_request" });
  });
});
