// レビューのテストの手伝い。代わりの GitHub に連携し、開発担当にプルリクエストを出させ、GitHub の形の通知を作る (GitHub の連携の 3.4、タスクとレビューの 3.2)
import { expect } from "vitest";
import { z } from "zod";
import { vaultForge } from "../../src/gate/github/vault-forge.ts";
import type { Forge } from "../../src/gate/work/loop.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { type Connected, connect, hook, wrapDb } from "./github.ts";
import { api, clockIn, idOf, purposeAndGoal, REPO, staffOf, type WorkWorld } from "./work.ts";

/** プルリクエストの先の sha。代わりの GitHub に置く */
export const HEAD = "b".repeat(40);
/** プルリクエストの元の sha */
export const BASE = "a".repeat(40);

/**
 * 写した本文が、末尾に順番待ちの目印を付けた形かを確かめる物を作る
 * @param body 目印の前の本文
 * @returns expect の中で比べる物
 */
export function marked(body: string): unknown {
  return expect.stringMatching(new RegExp(`^${body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n\n<!-- know-office:mirror:[0-9a-f-]{36} -->$`));
}

/** 開いたレビュー */
export type Opened = {
  /** 連携 */
  c: Connected;
  /** 開発担当のタスク。レビューの nodeId */
  task: string;
  /** プルリクエストの番号 */
  pr: number;
  /** ゲートウェイと同じく、vault の App の鍵から絞った鍵を作って GitHub を呼ぶ口 */
  forge: Forge;
};

/**
 * ゲートウェイと同じく、vault の App の鍵から絞った鍵を作って代わりの GitHub を呼ぶ口を作る
 * @param w テストの物
 * @returns GitHub を呼ぶ口
 */
export function appForge(w: WorkWorld): Forge {
  return vaultForge(w.gate.env, { fetcher: w.gate.fetch, clock: w.clock, cache: w.gate.githubCache });
}

/**
 * 連携し、3 人を出勤させ、開発担当にタスクを取らせる。代わりの GitHub はプルリクエストを 1 番で出す
 * @param w テストの物
 * @returns 連携と、開発担当のタスク
 */
export async function buildTaken(w: WorkWorld): Promise<{ c: Connected; task: string }> {
  const c = await connect(w);
  const { goal } = await purposeAndGoal(w);
  await clockIn(w, "president", "builder", "reviewer");
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
  const task = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "勤怠の表をつなぐ", taskKind: "build", assignee: "builder", repo: REPO }, 201));
  await staffOf(w, "builder").pull(w.clock.now());
  w.gate.github.set(`POST /repos/${REPO}/pulls`, { number: 1, base: { sha: BASE }, head: { sha: HEAD } });
  return { c, task };
}

/**
 * 連携し、3 人を出勤させ、開発担当に App の名前でプルリクエストを出させる。レビュー担当にレビューのタスクが付く
 * @param w テストの物
 * @returns 連携、タスク、プルリクエストの番号、GitHub を呼ぶ口
 */
export async function openReview(w: WorkWorld): Promise<Opened> {
  const { c, task } = await buildTaken(w);
  const forge = appForge(w);
  const opened = await runTool(w.gate.env, forge, { staffId: "builder", tool: "pr_open", input: { title: "勤怠の表をつなぐ", body: "" }, now: w.clock.now(), guard: w.gate.deps });
  if (opened.isError) throw new Error(opened.content);
  await staffOf(w, "reviewer").pull(w.clock.now());
  return { c, task, pr: 1, forge };
}

/**
 * 代わりの GitHub が受けた、プルリクエストへのレビューと行のコメントの要求
 * @param w テストの物
 * @param kind reviews か comments
 * @returns 要求の本文
 */
export function postedTo(w: WorkWorld, kind: "reviews" | "comments"): unknown[] {
  return w.gate.github.requests.filter((r) => r.route === `POST /repos/${REPO}/pulls/1/${kind}`).map((r) => r.body);
}

/**
 * 代わりの GitHub が送るはずの通知を、ゲートウェイに送って空にする
 * @param w テストの物
 * @param c 連携
 * @returns ゲートウェイの返事のステータス
 */
export async function deliverSent(w: WorkWorld, c: Connected): Promise<number[]> {
  const out: number[] = [];
  for (const s of w.gate.github.sent.splice(0)) out.push((await hook(w, { event: s.event, payload: s.payload, secret: c.webhookSecret })).status);
  return out;
}

/**
 * オーナーが GitHub の画面で出したレビューの通知の本文を作る
 * @param c 連携
 * @param state approved か changes_requested か commented
 * @param body 本文
 * @param association 書いた者とリポジトリの関わり。オーナーは OWNER
 * @param commitId レビューしたコミット
 * @returns 本文
 */
export function reviewHook(c: Connected, state: string, body: string, association = "OWNER", commitId: string = HEAD) {
  const user = { login: association === "OWNER" ? "example" : "someone", type: "User" };
  return { action: "submitted", review: { id: 9001, state, body, user, author_association: association, commit_id: commitId }, pull_request: { number: 1 }, repository: { full_name: REPO }, installation: { id: c.installationId }, sender: user };
}

/**
 * オーナーが GitHub の画面で書いた行のコメントの通知の本文を作る
 * @param c 連携
 * @param body 本文
 * @param association 書いた者とリポジトリの関わり。オーナーは OWNER
 * @returns 本文
 */
export function commentHook(c: Connected, body: string, association = "OWNER") {
  const user = { login: association === "OWNER" ? "example" : "someone", type: "User" };
  return {
    action: "created",
    comment: { id: 9100, body, path: "src/attendance.ts", line: 12, side: "RIGHT", user, author_association: association },
    pull_request: { number: 1 },
    repository: { full_name: REPO },
    installation: { id: c.installationId },
    sender: user,
  };
}

/**
 * ゲートウェイが DB に出したバッチの SQL を並べる。一緒に書く物が同じバッチに入るかを確かめる
 * @param w テストの物
 * @returns バッチごとの SQL の並びと、元に戻す関数
 */
export function spyBatches(w: WorkWorld): { batches: string[][]; restore: () => void } {
  const batches: string[][] = [];
  const restore = wrapDb(w, {
    batch: (real, statements) => {
      // 手元の D1 の文は、組み立てた SQL を statement に持つ
      batches.push(statements.map((s) => z.object({ statement: z.string() }).loose().catch({ statement: "" }).parse(s).statement));
      return real(statements);
    },
  });
  return { batches, restore };
}

/**
 * 並べたバッチのうち、どれか 1 つが SQL の頭をすべて含むか
 * @param batches バッチごとの SQL
 * @param heads SQL の頭
 * @returns 含むバッチがあれば true
 */
export function sameBatch(batches: string[][], ...heads: string[]): boolean {
  return batches.some((b) => heads.every((h) => b.some((sql) => sql.trimStart().startsWith(h))));
}

/** タスクの出来事のうち比べる所 */
const Events = z.object({ events: z.array(z.object({ kind: z.string(), staffId: z.string().nullable(), detail: z.record(z.string(), z.unknown()) })) }).loose();

/**
 * タスクの出来事を読む
 * @param w テストの物
 * @param task タスク ID
 * @returns 出来事
 */
export async function eventsOf(w: WorkWorld, task: string): Promise<z.infer<typeof Events>["events"]> {
  return Events.parse(await api(w, "GET", `/api/v1/nodes/${task}`)).events;
}
