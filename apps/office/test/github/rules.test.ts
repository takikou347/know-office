// GitHub のルールとブランチの保護。できる操作、触れない所、main に入れる条件をゲートウェイが守り、公開のリポジトリにはルールセットを掛け直す (タスクとレビューの 3.4)
import { newId, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { services } from "../../src/gate/db/main.ts";
import { createNode } from "../../src/gate/work/nodes.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { api, clockIn, MINUTE, purposeAndGoal, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

const UI = "example/knowidea-ui";
const OFFICE = "example/know-office";
const SHA = { base: "a".repeat(40), head: "b".repeat(40) };

/**
 * サービスを 1 つ置く。登録の流れ (9.2) の代わりに、リポジトリを決めた行を直に入れる
 * @param w テストの物
 * @param repo リポジトリ
 * @returns サービス ID
 */
async function service(w: WorkWorld, repo: string): Promise<string> {
  const id = newId(w.clock);
  await drizzle(w.d1.DB).insert(services).values({ id, name: repo.split("/")[1] ?? repo, kind: "library", stage: "operation", repo, staffId: "builder", createdAt: w.clock.now() });
  return id;
}

/**
 * 代わりの GitHub にリポジトリを置く。プルリクエスト、チェック、変えたファイル、ルールセットの返事を決める
 * @param w テストの物
 * @param repo リポジトリ
 * @param options 非公開か、変えたファイル
 * @param options.private 非公開なら true
 * @param options.files compare が返すファイル
 */
function repoOnGitHub(w: WorkWorld, repo: string, options: { private: boolean; files?: { filename: string; previous_filename?: string }[] }): void {
  const gh = w.gate.github;
  gh.set(`GET /repos/${repo}`, { full_name: repo, private: options.private, default_branch: "main" });
  gh.set(`GET /repos/${repo}/rulesets`, []);
  gh.set(`POST /repos/${repo}/rulesets`, { id: 7, name: "know-office" });
  gh.set(`GET /repos/${repo}/commits/main/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  gh.set(`POST /repos/${repo}/pulls`, { number: 1, base: { sha: SHA.base }, head: { sha: SHA.head } });
  gh.set(`GET /repos/${repo}/pulls/1`, { number: 1, base: { sha: SHA.base }, head: { sha: SHA.head } });
  gh.set(`GET /repos/${repo}/commits/${SHA.head}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  gh.set(`PATCH /repos/${repo}/git/refs/heads/main`, { ref: "refs/heads/main", object: { sha: SHA.head } });
  w.gate.github.files = options.files ?? [{ filename: "src/index.ts" }];
}

/**
 * 社員のツールを、代わりの GitHub につないだ口で呼ぶ
 * @param w テストの物
 * @param staffId 呼ぶ社員
 * @param name ツールの名前
 * @param input 入力
 * @returns ツールの答え
 */
function tool(w: WorkWorld, staffId: StaffId, name: string, input: unknown) {
  return runTool(w.gate.env, w.gate.forge, { staffId, tool: name, input, now: w.clock.now(), guard: w.gate.deps });
}

/**
 * 開発担当が作業中のタスクを 1 つ作る
 * @param w テストの物
 * @param repo 直すリポジトリ
 * @returns タスク ID
 */
async function buildTask(w: WorkWorld, repo: string): Promise<string> {
  const { goal } = await purposeAndGoal(w);
  await clockIn(w, "builder", "reviewer");
  const project = (await createNode(w.gate.env, { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, { by: "owner", now: w.clock.now() })).id;
  const task = (await createNode(w.gate.env, { kind: "task", parentId: project, scope: "office", title: "勤怠の表をつなぐ", taskKind: "build", assignee: "builder", repo }, { by: "owner", now: w.clock.now() })).id;
  await staffOf(w, "builder").pull(w.clock.now());
  return task;
}

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 代わりの GitHub に届いた、書く要求の「メソッド パス」
 * @param w テストの物
 * @returns GET を除いた要求
 */
function writes(w: WorkWorld): string[] {
  return w.gate.github.requests.map((r) => r.route).filter((r) => !r.startsWith("GET "));
}

/**
 * タスクの出来事の種類と中身を読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns 出来事
 */
async function events(w: WorkWorld, nodeId: string): Promise<{ kind: string; detail: unknown }[]> {
  const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.unknown() }).loose()) }).loose().parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  return detail.events.map((e) => ({ kind: e.kind, detail: e.detail }));
}

describe("GitHub のルール", () => {
  it("できる操作を絞る", async () => {
    const ui = await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    // main へのマージを外すのは守りを強める変更なので、パスキーは要らない
    await api(world, "PUT", `/api/v1/services/${ui}/settings/actions`, { version: 0, value: ["read", "branch", "push", "pull_request", "issue"], reason: "このサービスは main に入れさせない" });
    const task = await buildTask(world, UI);
    await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());

    const answer = await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ" });
    expect(JSON.parse(answer.content)).toEqual({ merged: false });
    expect(writes(world).filter((r) => r.includes("/git/refs/heads/main"))).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    expect((await events(world, task)).find((e) => e.kind === "merge_refused")).toEqual({ kind: "merge_refused", detail: { reason: "ルールで許していない操作: merge" } });
  });

  it("触れない所", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false, files: [{ filename: "src/index.ts" }, { filename: ".github/workflows/ci.yml" }] });
    const task = await buildTask(world, UI);

    await expect(tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" })).rejects.toMatchObject({ code: "rule_denied" });
    // GitHub にプルリクエストを出さず、ルールの外の操作として数えてタスクを止める
    expect(writes(world)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT scope, target, signal FROM stops")).toEqual([{ scope: "task", target: task, signal: "rule_denied" }]);
    expect(await rows(world.d1.DB, "SELECT id FROM nodes WHERE task_kind = 'review'")).toEqual([]);
  });
});

describe("ブランチの保護をルールから掛ける", () => {
  it("条件を変える", async () => {
    await service(world, UI);
    await service(world, OFFICE);
    repoOnGitHub(world, UI, { private: false });
    repoOnGitHub(world, OFFICE, { private: true });

    // 条件を足すのは守りを強める変更なので、パスキーは要らない
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "main はオーナーも確かめる" });
    // 公開のリポジトリには同じ条件のルールセットを掛け、非公開のリポジトリには掛けない
    const posted = world.gate.github.requests.filter((r) => r.route === `POST /repos/${UI}/rulesets`);
    expect(posted.map((r) => r.body)).toEqual([
      {
        name: "know-office",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "required_linear_history" },
          { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "verify" }] } },
          { type: "update" },
        ],
        bypass_actors: [
          { actor_id: 1234, actor_type: "Integration", bypass_mode: "always" },
          { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
        ],
      },
    ]);
    expect(writes(world).filter((r) => r.startsWith("POST /repos/example/know-office") || r.startsWith("PUT /repos/example/know-office"))).toEqual([]);
    // ルールセットを掛ける鍵は、そのリポジトリだけに絞り、ルールセットを書く権限を付ける
    expect(new Set(world.gate.githubTokens.filter((t) => t.permissions["administration"] === "write").map((t) => t.repo))).toEqual(new Set([UI]));

    // 非公開のリポジトリは、チェックとレビュー担当の承認がそろっても、オーナーの承認まで main を進めない
    const task = await buildTask(world, OFFICE);
    await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());
    expect(JSON.parse((await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ" })).content)).toEqual({ merged: false });
    expect(writes(world).filter((r) => r.includes("/git/refs/heads/main"))).toEqual([]);
    expect((await events(world, task)).find((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
  });
});

describe("GitHub のルールの決まり", () => {
  it("触れるリポジトリは初期値で連携したものすべてで、変えるにはパスキーの確認が要る", async () => {
    repoOnGitHub(world, UI, { private: true });
    expect(await api(world, "GET", "/api/v1/github/rules")).toEqual({ repos: null, version: 0 });
    expect(await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos: [UI], reason: "UI だけ" }, 401)).toMatchObject({ code: "step_up_required" });
    expect(world.gate.audits.filter((a) => a.action === "github.rules")).toEqual([]);
    await stepUp(world);
    expect(await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos: [UI], reason: "UI だけ" })).toEqual({ repos: [UI], version: 1 });
    expect(await api(world, "GET", "/api/v1/github/rules")).toEqual({ repos: [UI], version: 1 });
    expect(world.gate.audits.filter((a) => a.action === "github.rules")).toEqual([expect.objectContaining({ target: "github.rules", detail: { repos: [UI], version: 1, reason: "UI だけ" } })]);
    // 古い版を見て直した物は断る
    await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos: null, reason: "古い版から" }, 409);
  });

  it("触れるリポジトリの外のタスクはプルリクエストを出さない", async () => {
    repoOnGitHub(world, UI, { private: true });
    repoOnGitHub(world, OFFICE, { private: true });
    await stepUp(world);
    await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos: [UI], reason: "UI だけ" });
    await buildTask(world, OFFICE);
    await expect(tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" })).rejects.toMatchObject({ code: "rule_denied" });
    expect(writes(world)).toEqual([]);
  });

  it("同じ版で同時に変えると、片方だけを書いて片方を 409 にする", async () => {
    repoOnGitHub(world, UI, { private: true });
    repoOnGitHub(world, OFFICE, { private: true });
    await stepUp(world);
    const statuses = await Promise.all(
      [[UI], [OFFICE]].map(async (repos) => (await world.gate.request("/api/v1/github/rules", { method: "PUT", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: 0, repos, reason: "同時" }) })).status),
    );
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await rows(world.d1.DB, "SELECT version FROM settings WHERE key = 'github.rules'")).toEqual([{ version: 1 }]);
  });

  it("リポジトリの名前の形と数を確かめる", async () => {
    await stepUp(world);
    for (const repos of [["../etc"], ["example/.."], ["example/."], ["-x/y"], ["example"], ["example/a/b"], [UI, UI], Array.from({ length: 101 }, (_, i) => `example/r${String(i)}`)]) {
      await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos, reason: "形が違う" }, 422);
    }
    // 100 件までは入る
    const hundred = Array.from({ length: 100 }, (_, i) => `example/r${String(i)}`);
    for (const repo of hundred) repoOnGitHub(world, repo, { private: true });
    expect(await api(world, "PUT", "/api/v1/github/rules", { version: 0, repos: hundred, reason: "100 件" })).toMatchObject({ version: 1 });
  });

  it("ルールセットが既にあれば、作り足さずに置き換える", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    world.gate.github.set(`GET /repos/${UI}/rulesets`, [{ id: 42, name: "know-office" }, { id: 9, name: "other" }]);
    world.gate.github.set(`PUT /repos/${UI}/rulesets/42`, { id: 42, name: "know-office" });
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" });
    expect(writes(world)).toEqual([`PUT /repos/${UI}/rulesets/42`]);
  });

  it("条件にチェックも承認も無ければ、消すのと force push を断る事と一直線の履歴だけを掛ける", async () => {
    const ui = await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    await stepUp(world);
    await api(world, "PUT", `/api/v1/services/${ui}/settings/mergeWhen`, { version: 0, value: ["checks"], reason: "チェックだけ" });
    const body = z.object({ rules: z.array(z.object({ type: z.string() }).loose()), bypass_actors: z.array(z.unknown()) }).loose().parse(world.gate.github.requests.find((r) => r.route === `POST /repos/${UI}/rulesets`)?.body);
    expect(body.rules.map((r) => r.type)).toEqual(["deletion", "non_fast_forward", "required_linear_history", "required_status_checks"]);
    expect(body.bypass_actors).toEqual([]);
  });

  it("ルールセットを掛けられない時は 502 にし、変えた設定と記録は残す", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    world.gate.github.set(`POST /repos/${UI}/rulesets`, undefined);
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" }, 502);
    expect(await rows(world.d1.DB, "SELECT version FROM settings WHERE key = 'service.mergeWhen'")).toEqual([{ version: 1 }]);
    expect(world.gate.audits.filter((a) => a.action === "setting.update")).toHaveLength(1);
  });

  it("GitHub の返事の形が違う時は 502 にする", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    world.gate.github.set(`GET /repos/${UI}/rulesets`, [{ id: "../42", name: "know-office" }]);
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" }, 502);
    expect(writes(world)).toEqual([]);
  });

  it("触れない所の名前が似ているだけのファイルは通す", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false, files: [{ filename: ".github/workflows-old/ci.yml" }, { filename: "docs/github/workflows.md" }] });
    await buildTask(world, UI);
    expect(await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" })).toMatchObject({ isError: false });
    expect(writes(world)).toEqual([`POST /repos/${UI}/pulls`]);
  });

  it("触れない所から動かしたファイルは断る", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false, files: [{ filename: "ci.yml", previous_filename: ".github/workflows/ci.yml" }] });
    await buildTask(world, UI);
    await expect(tool(world, "builder", "pr_open", { name: "attendance-table", title: "動かす", body: "" })).rejects.toMatchObject({ code: "rule_denied" });
    expect(writes(world)).toEqual([]);
  });

  it("変えたファイルが 299 件なら全部を確かめて通す", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false, files: Array.from({ length: 299 }, (_, i) => ({ filename: `src/f${String(i)}.ts` })) });
    await buildTask(world, UI);
    expect(await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" })).toMatchObject({ isError: false });
  });

  it("変えたファイルが 300 件に届いて全部を確かめられない時は断る", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false, files: Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${String(i)}.ts` })) });
    await buildTask(world, UI);
    await expect(tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" })).rejects.toMatchObject({ code: "rule_denied" });
    expect(writes(world)).toEqual([]);
  });

  it("承認の後に触れない所を変えた push があれば、main を進めない", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    const task = await buildTask(world, UI);
    await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
    await staffOf(world, "reviewer").pull(world.clock.now());
    world.gate.github.files = [{ filename: ".github/workflows/ci.yml" }];
    expect(JSON.parse((await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "読んだ" })).content)).toEqual({ merged: false });
    expect(writes(world).filter((r) => r.includes("/git/refs/heads/main"))).toEqual([]);
    expect((await events(world, task)).find((e) => e.kind === "merge_refused")).toEqual({ kind: "merge_refused", detail: { reason: "ルールで触れない所: .github/workflows/ci.yml" } });
  });
});
