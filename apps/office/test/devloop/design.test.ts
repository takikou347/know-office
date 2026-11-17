// 試作に進めた案の設計書を開発担当が書き、最初の設計書をオーナーが決める (開発の回し方の 3.1、3.2)
import { AppError } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Connected, connect, hook, stepUp, wrapDb } from "../helpers/github.ts";
import { appForge } from "../helpers/review.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { api, clockIn, idOf, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

/** 設計書のリポジトリにする非公開のリポジトリと、もう 1 つの非公開のリポジトリ */
const DOCS = "example/knowidea-docs";
const DOCS2 = "example/other-docs";
/** サービスのリポジトリ。公開 */
const REPO = "example/video-maker";
const BASE = "a".repeat(40);
/** PR の先と、押された後の先と、設計書のリポジトリの既定のブランチの先 */
const HEAD = "b".repeat(40);
const NEXT = "c".repeat(40);
const MAIN = "d".repeat(40);

const VIDEO = { title: "動画を作るサービス", kind: "web_app", aim: "説明の動画を文章から作る", users: "小さな会社の広報", costEstimateMicroUsd: 30_000_000, revenueEstimateMicroUsd: 120_000_000 };

/** 形の合う設計書。kind が tool なので 01 だけでよい */
const README = ["---", "name: video-maker", "summary: 管理室", "repo: example/video-maker", "kind: tool", "status: planning", "visibility: public", "---", "", "# video-maker"].join("\n");
const GOOD: Record<string, string> = { "services/video-maker/README.md": README, "services/video-maker/docs/01-overview/index.md": "# 概要\n" };

/** 連携した App */
let linked: Connected;

/**
 * 失敗するはずの呼び出しを待ち、投げた AppError を返す
 * @param call 呼び出し
 * @returns 投げた AppError
 */
async function failure(call: Promise<unknown>): Promise<AppError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error("AppError で失敗しなかった");
  return error;
}

/**
 * 非公開のリポジトリを 2 つ足して GitHub につなぎ、パスキーの確認を済ませる
 * @param w テストの物
 */
async function link(w: WorkWorld): Promise<void> {
  w.gate.github.pick.push({ fullName: REPO, private: false }, { fullName: "example2/video-maker", private: false });
  linked = await connect(w);
  await stepUp(w);
}

/**
 * 設計書のリポジトリを PUT する
 * @param w テストの物
 * @param repo リポジトリ
 * @param version 読んだ版
 * @param status 待つステータス
 * @returns 返った data か problem
 */
function putDocs(w: WorkWorld, repo: string, version: number, status = 200): Promise<unknown> {
  return api(w, "PUT", "/api/v1/devloop/docs-repo", { repo, version, reason: "設計書の置き場にする" }, status);
}

/**
 * 案を足して検討に進める
 * @param w テストの物
 * @returns サービス ID
 */
async function studied(w: WorkWorld): Promise<string> {
  const id = idOf(await api(w, "POST", "/api/v1/services", VIDEO, 201));
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "study", reason: "調べる" });
  return id;
}

/**
 * 試作に進める
 * @param w テストの物
 * @param id サービス ID
 * @param repo サービスのリポジトリ
 * @param status 待つステータス
 * @returns 返った data か problem
 */
function toPrototype(w: WorkWorld, id: string, repo = REPO, status = 200): Promise<unknown> {
  return api(w, "POST", `/api/v1/services/${id}/advance`, { to: "prototype", reason: "作る", staffId: "builder", repo }, status);
}

/**
 * 設計書のリポジトリを選び、案を試作に進める
 * @param w テストの物
 * @returns サービス ID
 */
async function prototyped(w: WorkWorld): Promise<string> {
  await link(w);
  await putDocs(w, DOCS, 0);
  const id = await studied(w);
  await toPrototype(w, id);
  return id;
}

/**
 * 設計書を書くタスクの行を読む
 * @param w テストの物
 * @returns タスクの行
 */
function designTasks(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT id, title, assignee, task_kind, repo, scope, source, body, status FROM nodes WHERE source LIKE 'design:%'");
}

/**
 * 代わりの GitHub に、設計書のリポジトリのコミットの木と中身を置く
 * @param w テストの物
 * @param sha コミット
 * @param files 道と中身
 */
function docsAt(w: WorkWorld, sha: string, files: Record<string, string>): void {
  w.gate.github.set(`GET /repos/${DOCS}/git/trees/${sha}`, { sha, tree: Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob", sha: "1".repeat(40) })), truncated: false });
  for (const [path, text] of Object.entries(files)) w.gate.github.contents.set(`${sha}:${path}`, text);
}

/**
 * 代わりの GitHub に、プルリクエスト、チェック、main を進める返事と、変えたファイルを置く
 * @param w テストの物
 * @param changed 変えたファイルの道
 */
function pullOnGitHub(w: WorkWorld, changed: string[]): void {
  const gh = w.gate.github;
  gh.set(`POST /repos/${DOCS}/pulls`, { number: 1, base: { sha: BASE }, head: { sha: HEAD } });
  for (const sha of [HEAD, NEXT]) gh.set(`GET /repos/${DOCS}/commits/${sha}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  gh.set(`PATCH /repos/${DOCS}/git/refs/heads/main`, { ref: "refs/heads/main", object: { sha: HEAD } });
  gh.branchHeads.set("main", MAIN);
  gh.files = changed.map((filename) => ({ filename }));
}

/**
 * 社員のツールを、代わりの GitHub につないだ口で呼ぶ
 * @param w テストの物
 * @param staffId 呼ぶ社員
 * @param name ツールの名前
 * @param input 入力
 * @returns ツールの答え
 */
function tool(w: WorkWorld, staffId: "builder" | "reviewer", name: string, input: unknown) {
  return runTool(w.gate.env, appForge(w), { staffId, tool: name, input, now: w.clock.now(), guard: w.gate.deps });
}

/**
 * 開発担当が設計書を書くタスクを取る
 * @param w テストの物
 * @param id サービス ID
 * @returns タスク ID
 */
async function takeDesign(w: WorkWorld, id: string): Promise<string> {
  await clockIn(w, "president", "builder", "reviewer");
  await staffOf(w, "builder").pull(w.clock.now());
  const [task] = await rows(w.d1.DB, "SELECT id FROM nodes WHERE source = ?", `design:${id}`);
  return idOf(task);
}

/**
 * 設計書の PR を出し、レビュー担当がレビューのタスクを取るところまで進める
 * @param w テストの物
 * @param files PR の先の設計書
 * @param changed 変えたファイルの道
 * @returns 開発担当のタスク ID
 */
async function openedDocsPull(w: WorkWorld, files: Record<string, string> = GOOD, changed = Object.keys(files)): Promise<string> {
  const id = await prototyped(w);
  const task = await takeDesign(w, id);
  pullOnGitHub(w, changed);
  docsAt(w, HEAD, files);
  await tool(w, "builder", "pr_open", { name: "video-maker-docs", title: "video-maker の設計書", body: "" });
  await staffOf(w, "reviewer").pull(w.clock.now());
  return task;
}

/**
 * レビュー担当が承認する
 * @param w テストの物
 * @param headSha 読んだ先
 * @returns main に入れたか
 */
async function reviewerApproves(w: WorkWorld, headSha = HEAD): Promise<boolean> {
  const answer = await tool(w, "reviewer", "review_submit", { verdict: "approve", summary: "設計書の形と中身を確かめた", headSha });
  return z.object({ merged: z.boolean() }).parse(JSON.parse(answer.content)).merged;
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

/**
 * main を進めた要求の本文
 * @param w テストの物
 * @returns 本文
 */
function mainMoves(w: WorkWorld): unknown[] {
  return w.gate.github.requests.filter((r) => r.route === `PATCH /repos/${DOCS}/git/refs/heads/main`).map((r) => r.body);
}

/**
 * 出した PR の数
 * @param w テストの物
 * @returns POST /pulls を受けた数
 */
function pullsOpened(w: WorkWorld): number {
  return w.gate.github.requests.filter((r) => r.route === `POST /repos/${DOCS}/pulls`).length;
}

/**
 * GitHub から PR の先が進んだ通知を送る
 * @param w テストの物
 * @param repo リポジトリ
 * @param sha 新しい先
 */
async function synchronize(w: WorkWorld, repo: string, sha: string): Promise<void> {
  const payload = { action: "synchronize", pull_request: { number: 1, head: { sha } }, repository: { full_name: repo }, installation: { id: linked.installationId } };
  expect((await hook(w, { event: "pull_request", payload, secret: linked.webhookSecret })).status).toBe(204);
}

describe("決まった形の設計書", () => {
  it("設計書を書くタスク", async () => {
    await link(world);
    expect(await api(world, "GET", "/api/v1/devloop/docs-repo")).toEqual({ repo: null, version: 0 });
    expect(await putDocs(world, DOCS, 0)).toEqual({ repo: DOCS, version: 1 });
    expect(await api(world, "GET", "/api/v1/devloop/docs-repo")).toEqual({ repo: DOCS, version: 1 });

    const id = await studied(world);
    expect(await toPrototype(world, id)).toMatchObject({ stage: "prototype" });
    // 開発担当に、設計書のリポジトリへ書く 1 件のタスクが足される
    const [task, ...rest] = await designTasks(world);
    expect(rest).toEqual([]);
    expect(task).toMatchObject({ title: "設計書: 動画を作るサービス", assignee: "builder", task_kind: "build", repo: DOCS, scope: id, source: `design:${id}`, status: "todo" });
    expect(String(task?.["body"])).toContain("services/video-maker/");
    expect(String(task?.["body"])).toContain("WRITING.md");
    expect((await events(world, idOf(task)))[0]).toMatchObject({ kind: "created" });
  });

  it("設計書のリポジトリが無い", async () => {
    // GitHub とつなぐ前は、選べず 409
    await stepUp(world);
    expect(await putDocs(world, DOCS, 0, 409)).toMatchObject({ code: "conflict" });
    await link(world);
    const id = await studied(world);
    // 未設定なら試作に進めず 409。段階もタスクも変わらない
    expect(await toPrototype(world, id, REPO, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "study" }]);
    expect(await designTasks(world)).toEqual([]);

    // 公開のリポジトリ、触れる外、形の違う名前は 422
    for (const repo of [REPO, "example/elsewhere", "../x"]) expect(await putDocs(world, repo, 0, 422)).toMatchObject({ code: "validation_failed" });
    // 版違いは 409
    expect(await putDocs(world, DOCS, 5, 409)).toMatchObject({ code: "conflict" });
    // サービスのリポジトリは選べない
    await world.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(DOCS2, id).run();
    expect(await putDocs(world, DOCS2, 0, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "GET", "/api/v1/devloop/docs-repo")).toEqual({ repo: null, version: 0 });
    await world.d1.DB.prepare("UPDATE services SET repo = NULL WHERE id = ?").bind(id).run();

    // 選んだ後でも、触れるリポジトリから外れれば試作に進めず 409
    await putDocs(world, DOCS, 0);
    const installation = world.gate.github.installations.get(linked.installationId);
    if (!installation) throw new Error("インストールが無い");
    const kept = installation.repos;
    installation.repos = kept.filter((r) => r !== DOCS);
    expect(await toPrototype(world, id, REPO, 409)).toMatchObject({ code: "conflict" });
    installation.repos = kept;
    expect(await toPrototype(world, id)).toMatchObject({ stage: "prototype" });
  });

  it("形の違う設計書", async () => {
    // 要件の無い詳細設計。kind が app なので 04 と 05 の index.md も要る
    const bad = { ...GOOD, "services/video-maker/README.md": README.replace("kind: tool", "kind: app"), "services/video-maker/docs/04-detail/1-x.md": "# x\n\n## 1. 要件\n\nだけ\n" };
    const id = await prototyped(world);
    const task = await takeDesign(world, id);
    pullOnGitHub(world, Object.keys(bad));
    docsAt(world, HEAD, bad);
    // GitHub に出す前に 422 で断り、直す所を返す。PR は出さず、タスクは作業中のまま
    const refused = await failure(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" }));
    expect(refused.code).toBe("validation_failed");
    expect(refused.errors?.map((e) => e.pointer)).toContain("#/files/docs/04-detail/1-x.md");
    expect(pullsOpened(world)).toBe(0);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);

    // 直せば出せる
    docsAt(world, HEAD, GOOD);
    pullOnGitHub(world, Object.keys(GOOD));
    expect(await tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).toMatchObject({ isError: false });
    expect(pullsOpened(world)).toBe(1);
  });

  it("最初の設計書はオーナーが決める", async () => {
    const task = await openedDocsPull(world);
    // 既定のブランチに README が無い最初の設計書は、レビュー担当の承認だけでは入らない
    expect(await reviewerApproves(world)).toBe(false);
    expect(mainMoves(world)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    expect((await events(world, task)).find((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });

    // オーナーの承認がそろうと入る
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "設計書を読んだ", baseSha: HEAD });
    expect(mainMoves(world)).toEqual([{ sha: HEAD, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("設定で弱められない", async () => {
    // office の初期値の入れる条件を checks だけにしても、保護する道は office の初期値のままで、入れる条件は設計書の物
    await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'service.mergeWhen', 'office', ?, 1, 'owner', '弱める', 1)").bind(crypto.randomUUID(), JSON.stringify(["checks"])).run();
    const task = await openedDocsPull(world);
    expect(await reviewerApproves(world)).toBe(false);
    expect((await events(world, task)).find((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });
    expect(mainMoves(world)).toEqual([]);

    // 入れる前に、触れない所を変える push があれば、設定に関わらず断る
    pullOnGitHub(world, [...Object.keys(GOOD), ".github/workflows/x.yml"]);
    await synchronize(world, DOCS, NEXT);
    docsAt(world, NEXT, GOOD);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "読んだ", baseSha: NEXT });
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_refused")).toBe(true);
  });

  it("試作に進める同時の 2 回は、タスクも段階も 1 回だけ", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const id = await studied(world);
    const results = await Promise.all([toPrototype(world, id, REPO, 200).catch((e: unknown) => e), toPrototype(world, id, REPO, 409).catch((e: unknown) => e)]);
    expect(results).toHaveLength(2);
    expect(await designTasks(world)).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "prototype" }]);
  });

  it("試作に進める前に設計書のリポジトリの設定が変われば、段階もタスクも変わらない", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const id = await studied(world);
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        restore();
        await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'devloop.docs_repo', 'office', ?, 2, 'owner', '変える', 2)").bind(crypto.randomUUID(), JSON.stringify({ repo: DOCS2 })).run();
        return real(statements);
      },
    });
    expect(await toPrototype(world, id, REPO, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "study" }]);
    expect(await designTasks(world)).toEqual([]);
  });

  it("同じ名前のリポジトリを持つ別のサービスがあれば、試作に進めない", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const first = await studied(world);
    await toPrototype(world, first);
    const second = await studied(world);
    // 設計書の置き場 services/video-maker/ が重なる。名前は大文字小文字を分けない
    expect(await toPrototype(world, second, "example2/video-maker", 409)).toMatchObject({ code: "conflict" });
    expect(await designTasks(world)).toHaveLength(1);
  });

  it("設計書のリポジトリを後からサービスのリポジトリに選べない", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const id = await studied(world);
    // 試作に進める時の repo も、設定で変える repo も、今の設計書のリポジトリなら 409
    expect(await toPrototype(world, id, DOCS, 409)).toMatchObject({ code: "conflict" });
    await toPrototype(world, id);
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: DOCS, reason: "移す" }, 409)).toMatchObject({ code: "conflict" });
    // 大文字にした別の書き方でも同じ
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: DOCS.toUpperCase(), reason: "移す" }, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT repo FROM services WHERE id = ?", id)).toEqual([{ repo: REPO }]);
  });

  it("PR を出した後に形を壊す push は main に入らない", async () => {
    const task = await openedDocsPull(world);
    // 押された後の先は README を消している
    const broken = { "services/video-maker/docs/01-overview/index.md": "# 概要\n" };
    docsAt(world, NEXT, broken);
    pullOnGitHub(world, Object.keys(broken));
    await synchronize(world, DOCS, NEXT);
    // README が無いので最初の設計書と読めるが、形の外れが先に断る
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "読んだ", baseSha: NEXT });
    expect(await reviewerApproves(world, NEXT)).toBe(false);
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_refused")).toBe(true);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
  });

  it("設計書の PR の変えた道が空か外れていれば断る", async () => {
    const id = await prototyped(world);
    const task = await takeDesign(world, id);
    docsAt(world, HEAD, GOOD);
    // 変えた道が無い、services/<名前>/ の外、2 つのサービスにまたがる、形の違う名前は、PR を出す前に断る
    for (const changed of [[], ["WRITING.md"], ["services/video-maker/README.md", "services/other/README.md"], ["services/video-maker/README.md", "README.md"], ["services/.hidden/README.md"], ["services/A_b/README.md"], ["services/../README.md"]]) {
      pullOnGitHub(world, changed);
      // 変えた道が無い時と外れた時は 422、道が確かめ切れない時の形は rule_denied
      expect(["validation_failed", "rule_denied"]).toContain((await failure(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" }))).code);
    }
    expect(pullsOpened(world)).toBe(0);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
  });

  it("設計書の木が切られたら 502 で、中身を読むファイルが 60 件を超えたら断る", async () => {
    const id = await prototyped(world);
    await takeDesign(world, id);
    pullOnGitHub(world, Object.keys(GOOD));
    // GitHub が木を切った (truncated) 時は、読み切れないので 502
    world.gate.github.set(`GET /repos/${DOCS}/git/trees/${HEAD}`, { sha: HEAD, tree: [], truncated: true });
    await expect(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).rejects.toMatchObject({ code: "upstream_failed" });
    // 60 件ちょうどは読み、61 件は読まずに断る
    const many = (n: number) => ({ ...GOOD, ...Object.fromEntries(Array.from({ length: n - 2 }, (_, i) => [`services/video-maker/docs/04-detail/${String(i + 1)}-f.md`, "# f\n\n## 1. 要件\n\n- **a**: b\n"])) });
    docsAt(world, HEAD, many(61));
    await expect(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).rejects.toMatchObject({ code: "validation_failed" });
    expect(pullsOpened(world)).toBe(0);
    const contentReads = () => world.gate.github.requests.filter((r) => r.route.includes("/contents/")).length;
    const before = contentReads();
    docsAt(world, HEAD, many(60));
    expect(await tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).toMatchObject({ isError: false });
    expect(contentReads() - before).toBe(60);
  });

  it("README の読みが落ちたら最初かどうかを決めず、待たずに失敗にする", async () => {
    const task = await openedDocsPull(world);
    world.gate.github.failNext(`GET /repos/${DOCS}/contents/services/video-maker/README.md`, 500);
    await expect(reviewerApproves(world)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_waiting")).toBe(false);
  });

  it("既定のブランチに README があれば、チェックとレビュー担当の承認だけで入る", async () => {
    pullOnGitHub(world, []);
    world.gate.github.contents.set(`${MAIN}:services/video-maker/README.md`, README);
    const task = await openedDocsPull(world);
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world)).toEqual([{ sha: HEAD, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("設計書のリポジトリを別に変えた後の古いリポジトリは、普通のルールに戻る", async () => {
    const task = await openedDocsPull(world);
    await stepUp(world);
    await putDocs(world, DOCS2, 1);
    // 古い方は設計書の決まりを外れ、office の初期値のチェックとレビュー担当の承認だけで入る
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world)).toEqual([{ sha: HEAD, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("別の書き方のリポジトリ名でも差し替えを外せない", async () => {
    await link(world);
    // 大文字にした名前で選んでも、GitHub の名前で持つ。サービスのリポジトリにも同じ名前は選べない
    expect(await putDocs(world, DOCS.toUpperCase(), 0)).toEqual({ repo: DOCS, version: 1 });
    const id = await studied(world);
    expect(await toPrototype(world, id, DOCS.toUpperCase(), 409)).toMatchObject({ code: "conflict" });
    await world.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(DOCS2.toUpperCase(), id).run();
    expect(await putDocs(world, DOCS2, 1, 422)).toMatchObject({ code: "validation_failed" });
  });
});
