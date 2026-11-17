// 設計書から Issue を作るテストの手伝い。設計書を代わりの GitHub の main に置き、社長の issue_plan を呼び、代わりの GitHub に出来た Issue と dev_issues とタスクを読む (開発の回し方の 3.3)
import { AppError, type ToolResult } from "@know-office/core";
import { z } from "zod";
import type { FakeIssue } from "../../dev/github-issues.ts";
import { vaultForge } from "../../src/gate/github/vault-forge.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import type { Forge } from "../../src/gate/work/loop.ts";
import { DOCS, HEAD, MAIN, NEXT, REPO, README, docsAt, prototyped } from "./docs.ts";
import { rows, type WorkWorld } from "./work.ts";

/**
 * 設計書の機能のファイル。1 章の要件が 2 つ
 * @param change 要件の本文の差し替え。second が null なら 2 つ目の要件を無くす
 * @param change.first 動画を作る の本文
 * @param change.second 動画を見る の本文。null なら要件ごと無くす
 * @param title 機能の名前
 * @returns 詳細設計の機能のファイル
 */
export function detail(change: { first?: string; second?: string | null } = {}, title = "動画"): string {
  const second = change.second === null ? [] : [`- **動画を見る**: ${change.second ?? "一覧で見る"}`];
  return [`# 詳細設計 1. ${title}`, "", "## 1. 要件", "", `- **動画を作る**: ${change.first ?? "文章から作る"}`, ...second, "", "## 2. 作る物", "", "- **ここは要件でない**: 2 章の項目"].join("\n");
}

/** 設計書のサービスの置き場の頭 */
export const BASE = "services/video-maker/docs/04-detail";

/**
 * 子 1 件の入力
 * @param requirement 要件の名前
 * @param extra 足す項目
 * @returns 子の入力
 */
export function child(requirement: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requirement, kind: "feature", paths: ["src/a.ts"], ...extra };
}

/**
 * issue_plan の入力。親 1 件
 * @param serviceId サービス ID
 * @param children 子の入力
 * @param feature 機能のファイルの名前
 * @returns issue_plan の入力
 */
export function planOf(serviceId: string, children: Record<string, unknown>[], feature = "1-video"): Record<string, unknown> {
  return { serviceId, parents: [{ feature, children }] };
}

/**
 * 書きの間の待ちを数える、GitHub を呼ぶ口を作る
 * @param w テストの物
 * @param onPause 待つたびに呼ぶ。待った時間を受ける
 * @returns GitHub を呼ぶ口
 */
export function pacedForge(w: WorkWorld, onPause: (ms: number) => void = () => undefined): Forge {
  return vaultForge(w.gate.env, { fetcher: w.gate.fetch, clock: w.clock, cache: w.gate.githubCache, pause: (ms) => Promise.resolve(onPause(ms)) });
}

/**
 * 社員のツール issue_plan を呼ぶ
 * @param w テストの物
 * @param input 入力
 * @param options 呼ぶ社員と、GitHub を呼ぶ口
 * @param options.staffId 呼ぶ社員
 * @param options.forge GitHub を呼ぶ口
 * @returns ツールの答え
 */
export function callPlan(w: WorkWorld, input: unknown, options: { staffId?: "president" | "builder"; forge?: Forge } = {}): Promise<ToolResult> {
  return runTool(w.gate.env, options.forge ?? pacedForge(w), { staffId: options.staffId ?? "president", tool: "issue_plan", input, now: w.clock.now(), guard: w.gate.deps });
}

const Plan = z.object({
  parents: z.array(z.object({ feature: z.string(), number: z.number() })),
  children: z.array(z.object({ feature: z.string(), requirement: z.string(), number: z.number(), created: z.boolean() })),
  closed: z.array(z.number()),
  running: z.array(z.number()),
  more: z.boolean(),
});

/**
 * issue_plan を呼び、答えを読む
 * @param w テストの物
 * @param input 入力
 * @param forge GitHub を呼ぶ口。無ければ既定
 * @returns 作った物と今あった物の番号
 */
export async function plan(w: WorkWorld, input: unknown, forge?: Forge): Promise<z.infer<typeof Plan>> {
  return Plan.parse(JSON.parse((await callPlan(w, input, forge === undefined ? {} : { forge })).content));
}

/**
 * 失敗するはずの issue_plan を呼び、投げた AppError を返す
 * @param w テストの物
 * @param input 入力
 * @param options 呼ぶ社員と口
 * @param options.staffId 呼ぶ社員
 * @param options.forge GitHub を呼ぶ口
 * @returns 投げた AppError
 */
export async function planFails(w: WorkWorld, input: unknown, options: { staffId?: "president" | "builder"; forge?: Forge } = {}): Promise<AppError> {
  const error = await callPlan(w, input, options).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error("AppError で失敗しなかった");
  return error;
}

/**
 * 試作のサービスと設計書 (README と機能のファイル) を main に置く
 * @param w テストの物
 * @param files 機能のファイル。道は services/video-maker/docs/04-detail/ からの名前
 * @returns サービス ID
 */
export async function withDocs(w: WorkWorld, files: Record<string, string> = { "1-video.md": detail() }): Promise<string> {
  const id = await prototyped(w);
  // 設計書の main の先 (HEAD) と、push の通知の先 (NEXT、MAIN) に同じ設計書を置く
  for (const sha of [HEAD, NEXT, MAIN]) docsAt(w, sha, { "services/video-maker/README.md": README, ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`${BASE}/${name}`, text])) });
  return id;
}

/**
 * 設計書の機能のファイルを書き換える
 * @param w テストの物
 * @param name ファイルの名前
 * @param text 中身
 */
export function rewriteDocs(w: WorkWorld, name: string, text: string | null): void {
  for (const sha of [HEAD, NEXT, MAIN]) {
    const key = `${sha}:${BASE}/${name}`;
    if (text === null) w.gate.github.contents.delete(key);
    else w.gate.github.contents.set(key, text);
  }
}

/**
 * 代わりの GitHub のサービスのリポジトリの Issue を読む
 * @param w テストの物
 * @returns Issue
 */
export function issuesOf(w: WorkWorld): FakeIssue[] {
  return w.gate.github.issues.items.get(REPO) ?? [];
}

/**
 * dev_issues の行を読む
 * @param w テストの物
 * @returns 行
 */
export function devRows(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT kind, feature, requirement, req_hash, number, parent_number, state, issue_kind FROM dev_issues ORDER BY number");
}

/**
 * 子 Issue の開発担当のタスクを読む
 * @param w テストの物
 * @returns タスクの行
 */
export function buildTasks(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT title, body, assignee, task_kind, repo, scope, source, status, priority FROM nodes WHERE source LIKE 'issue:%' ORDER BY source");
}

export { DOCS, HEAD, REPO };
