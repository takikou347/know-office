// 設計書の PR のテストの手伝い。設計書のリポジトリを選び、案を試作に進め、設計書の PR を出させ、承認と main に入れる所までを代わりの GitHub の上で進める (開発の回し方の 3.1、3.2)
import { AppError } from "@know-office/core";
import { expect } from "vitest";
import { z } from "zod";
import { type Connected, connect, hook, stepUp } from "../helpers/github.ts";
import { appForge } from "../helpers/review.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { api, clockIn, idOf, rows, staffOf, type WorkWorld } from "../helpers/work.ts";


/** 設計書のリポジトリにする非公開のリポジトリと、もう 1 つの非公開のリポジトリ */
export const DOCS = "example/knowidea-docs";
export const DOCS2 = "example/other-docs";
/** サービスのリポジトリ。公開 */
export const REPO = "example/video-maker";
/** 名前の重ならないサービスのリポジトリ。名前に大文字を含む物と、小文字にしても置き場にできない物 */
export const OTHER_APP = "example2/other-app";
export const BIG_NAME = "example2/Big-Name";
export const HIDDEN = "example2/.hidden";
export const BASE = "a".repeat(40);
/** PR の先と、押された後の先と、設計書のリポジトリの既定のブランチの先 */
export const HEAD = "b".repeat(40);
export const NEXT = "c".repeat(40);
export const MAIN = "d".repeat(40);

export const VIDEO = { title: "動画を作るサービス", kind: "web_app", aim: "説明の動画を文章から作る", users: "小さな会社の広報", costEstimateMicroUsd: 30_000_000, revenueEstimateMicroUsd: 120_000_000 };

/** 形の合う設計書。kind が tool なので 01 だけでよい */
export const README = ["---", "name: video-maker", "summary: 管理室", "repo: example/video-maker", "kind: tool", "status: planning", "visibility: public", "---", "", "# video-maker"].join("\n");
export const GOOD: Record<string, string> = { "services/video-maker/README.md": README, "services/video-maker/docs/01-overview/index.md": "# 概要\n" };

/** 連携した App */
let linked: Connected;

/** @returns 連携した App */
export function linkedApp(): Connected {
  return linked;
}

/**
 * 失敗するはずの呼び出しを待ち、投げた AppError を返す
 * @param call 呼び出し
 * @returns 投げた AppError
 */
export async function failure(call: Promise<unknown>): Promise<AppError> {
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
export async function link(w: WorkWorld): Promise<void> {
  w.gate.github.pick.push({ fullName: REPO, private: false }, { fullName: "example2/video-maker", private: false }, { fullName: OTHER_APP, private: false }, { fullName: BIG_NAME, private: false }, { fullName: HIDDEN, private: false });
  linked = await connect(w);
  await stepUp(w);
}

/**
 * 設定を直に置く。設計書のリポジトリが後から変わった時と、ほかの所で決めた設定の代わり
 * @param w テストの物
 * @param key 設定のキー
 * @param value 値
 * @param version 版
 */
export async function seedSetting(w: WorkWorld, key: string, value: unknown, version: number): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, ?, 'office', ?, ?, 'owner', 'テスト', 1)").bind(crypto.randomUUID(), key, JSON.stringify(value), version).run();
}

/**
 * 設計書のリポジトリを PUT する
 * @param w テストの物
 * @param repo リポジトリ
 * @param version 読んだ版
 * @param status 待つステータス
 * @returns 返った data か problem
 */
export function putDocs(w: WorkWorld, repo: string, version: number, status = 200): Promise<unknown> {
  return api(w, "PUT", "/api/v1/devloop/docs-repo", { repo, version, reason: "設計書の置き場にする" }, status);
}

/**
 * 案を足して検討に進める
 * @param w テストの物
 * @returns サービス ID
 */
export async function studied(w: WorkWorld): Promise<string> {
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
export function toPrototype(w: WorkWorld, id: string, repo = REPO, status = 200): Promise<unknown> {
  return api(w, "POST", `/api/v1/services/${id}/advance`, { to: "prototype", reason: "作る", staffId: "builder", repo }, status);
}

/**
 * 設計書のリポジトリを選び、案を試作に進める
 * @param w テストの物
 * @returns サービス ID
 */
export async function prototyped(w: WorkWorld): Promise<string> {
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
export function designTasks(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT id, title, assignee, task_kind, repo, scope, source, body, status FROM nodes WHERE source LIKE 'design:%'");
}

/**
 * 代わりの GitHub に、設計書のリポジトリのコミットの木と中身を置く
 * @param w テストの物
 * @param sha コミット
 * @param files 道と中身
 */
export function docsAt(w: WorkWorld, sha: string, files: Record<string, string>): void {
  w.gate.github.set(`GET /repos/${DOCS}/git/trees/${sha}`, { sha, tree: Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob", sha: "1".repeat(40) })), truncated: false });
  for (const [path, text] of Object.entries(files)) w.gate.github.contents.set(`${sha}:${path}`, text);
}

/**
 * 代わりの GitHub に、プルリクエスト、チェック、main を進める返事と、変えたファイルを置く
 * @param w テストの物
 * @param changed 変えたファイルの道
 */
export function pullOnGitHub(w: WorkWorld, changed: string[]): void {
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
export function tool(w: WorkWorld, staffId: "builder" | "reviewer", name: string, input: unknown) {
  return runTool(w.gate.env, appForge(w), { staffId, tool: name, input, now: w.clock.now(), guard: w.gate.deps });
}

/**
 * 開発担当が設計書を書くタスクを取る
 * @param w テストの物
 * @param id サービス ID
 * @returns タスク ID
 */
export async function takeDesign(w: WorkWorld, id: string): Promise<string> {
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
export async function openedDocsPull(w: WorkWorld, files: Record<string, string> = GOOD, changed = Object.keys(files)): Promise<string> {
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
export async function reviewerApproves(w: WorkWorld, headSha = HEAD): Promise<boolean> {
  const answer = await tool(w, "reviewer", "review_submit", { verdict: "approve", summary: "設計書の形と中身を確かめた", headSha });
  return z.object({ merged: z.boolean() }).parse(JSON.parse(answer.content)).merged;
}

/**
 * タスクの出来事の種類と中身を読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns 出来事
 */
export async function events(w: WorkWorld, nodeId: string): Promise<{ kind: string; detail: unknown }[]> {
  const detail = z.object({ events: z.array(z.object({ kind: z.string(), detail: z.unknown() }).loose()) }).loose().parse(await api(w, "GET", `/api/v1/nodes/${nodeId}`));
  return detail.events.map((e) => ({ kind: e.kind, detail: e.detail }));
}

/**
 * main を進めた要求の本文
 * @param w テストの物
 * @returns 本文
 */
export function mainMoves(w: WorkWorld): unknown[] {
  return w.gate.github.requests.filter((r) => r.route === `PATCH /repos/${DOCS}/git/refs/heads/main`).map((r) => r.body);
}

/**
 * 出した PR の数
 * @param w テストの物
 * @returns POST /pulls を受けた数
 */
export function pullsOpened(w: WorkWorld): number {
  return w.gate.github.requests.filter((r) => r.route === `POST /repos/${DOCS}/pulls`).length;
}

/**
 * GitHub から PR の先が進んだ通知を送る
 * @param w テストの物
 * @param repo リポジトリ
 * @param sha 新しい先
 */
export async function synchronize(w: WorkWorld, repo: string, sha: string): Promise<void> {
  const payload = { action: "synchronize", pull_request: { number: 1, head: { sha } }, repository: { full_name: repo }, installation: { id: linked.installationId } };
  expect((await hook(w, { event: "pull_request", payload, secret: linked.webhookSecret })).status).toBe(204);
}

