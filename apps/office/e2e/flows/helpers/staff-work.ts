// 社員の仕事の通しが使う、通しの木、レビュー担当に積む返事、タスクを足して終えるまでを待つ道具。出勤と返事を積む道具は staff.ts (社員が考えるの 3.3)
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect } from "../../helpers/test.ts";
import { seedMain } from "./seed.ts";
import { part, post } from "./screen.ts";
import { resumeStaff, scriptReply } from "./staff.ts";
import { FAKES } from "../../helpers/fakes.ts";

/** 通しの置き場の木。目的と組織図の画面の見本の木と分け、見本の進み具合を変えない */
export const PURPOSE = "019a7b00-0000-7000-8000-0000000000e1";
export const GOAL = "019a7b00-0000-7000-8000-0000000000e2";
export const PROJECT = "019a7b00-0000-7000-8000-0000000000e3";

export type Tree = { id: string; title: string; children: Tree[] };
export const Tree: z.ZodType<Tree> = z
  .object({
    id: z.string(),
    title: z.string(),
    get children() {
      return z.array(Tree);
    },
  })
  .loose();
export const Trees = z.object({ data: z.array(Tree) });
export const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });
export const NodeVersion = z.object({ data: z.object({ version: z.number() }).loose() });
export const NodeDetail = z.object({ data: z.object({ status: z.string(), version: z.number() }).loose() });
export const Held = z.object({ data: z.array(z.object({ id: z.string(), nodeId: z.string().nullable() }).loose()) });
export const Runs = z.array(z.object({ staffId: z.string(), nodeId: z.string() }));
export const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), target: z.string(), stopId: z.string() })) }) });

/**
 * 代わりの Claude API に、レビュー担当の SDK が受ける終わりの返事を 1 つ積む
 * @param page 画面を開いたページ
 */
export async function scriptFinish(page: Page): Promise<void> {
  await scriptReply(page, "reviewer", [{ type: "text", text: "通しのタスクを終えた" }], "end_turn");
}

/**
 * 通しの木を開き、止めたままの社員を再開する
 * @param page 画面を開くページ
 */
export async function openTree(page: Page): Promise<void> {
  seedMain(
    "INSERT OR IGNORE INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES " +
      `('${PURPOSE}', 'purpose', NULL, 'office', '社員の仕事の通し', NULL, NULL, NULL, 'todo', 900, 'owner', 1794528000000, 1794528000000), ` +
      `('${GOAL}', 'goal', '${PURPOSE}', 'office', '社員がタスクを始める', NULL, NULL, NULL, 'todo', 900, 'owner', 1794528000000, 1794528000000), ` +
      `('${PROJECT}', 'project', '${GOAL}', 'office', '通しのタスク', NULL, NULL, NULL, 'todo', 900, 'owner', 1794528000000, 1794528000000)`,
  );
  await page.goto("/goals");
  await expect(page.getByRole("heading", { level: 2, name: "目的: 社員の仕事の通し" })).toBeVisible();
  await resumeStaff(page);
}

/**
 * 通しのプロジェクトの「タスクを足す」から、題と頼む先を入れてタスクを足し、木に出るのを待つ
 * @param page 画面を開いたページ
 * @param title 題
 * @param assignee 頼む先の役職。まだ頼まない時は「まだ頼まない」
 * @returns 足したタスクの ID
 */
export async function addTask(page: Page, title: string, assignee: string): Promise<string> {
  const tree = part(page, "目的: 社員の仕事の通し");
  await tree.getByRole("button", { name: "「社員がタスクを始める」の「通しのタスク」にタスクを足す" }).click();
  const dialog = page.getByRole("dialog", { name: "「社員がタスクを始める」の「通しのタスク」にタスクを足す" });
  await dialog.getByRole("textbox", { name: "題" }).fill(title);
  await dialog.getByRole("textbox", { name: "本文" }).fill("通しで足したタスク");
  await dialog.getByRole("radiogroup", { name: "種類" }).getByRole("radio", { name: "作る" }).click();
  await dialog.getByRole("radiogroup", { name: "頼む先" }).getByRole("radio", { name: assignee }).click();
  await dialog.getByRole("textbox", { name: "リポジトリ" }).fill("example/know-office");
  await dialog.getByRole("button", { name: "タスクを足す" }).click();
  await expect(dialog).toBeHidden();
  await expect(tree.getByText(`タスク: ${title}`)).toBeVisible();
  const found = Trees.parse(await (await page.request.get(`/api/v1/nodes?rootId=${PURPOSE}`)).json())
    .data.flatMap(function walk(n: Tree): Tree[] {
      return [n, ...n.children.flatMap(walk)];
    })
    .find((n) => n.title === title);
  expect(found).toBeDefined();
  return found?.id ?? "";
}

/**
 * 社員がタスクを取り、開発のコンテナの代わりがタスクの開始を受け、終えた知らせでタスクが done になるのを待つ。社員は終えて離れるので、通しの後に片付けない
 * @param page 画面を開いたページ
 * @param nodeId タスク ID
 */
export async function finishedBy(page: Page, nodeId: string): Promise<void> {
  // 社員 DO は取った後に鎖の外で呼び出しを始め、開発のコンテナの代わりが /v1/runs を受ける。すぐ終えるので doing の間は待たない
  await expect
    .poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 })
    .toContainEqual({ staffId: "reviewer", nodeId });
  // SDK が終えると、代わりのワークスペースがゲートウェイの開発の道に終わりを送り、タスクが done になって社員が離れる
  await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status, { timeout: 60_000 }).toBe("done");
}

/**
 * 代わりの Claude API に、レビュー担当が発言し、チェックポイントを伝え、終わりの文で終える返事を順に積む
 * @param page 画面を開いたページ
 * @param said 発言の本文
 */
export async function scriptWork(page: Page, said: string): Promise<void> {
  await scriptReply(page, "reviewer", [{ type: "tool_use", id: "toolu_flow_report", name: "mcp__staff__report", input: { body: said } }], "tool_use");
  await scriptReply(page, "reviewer", [{ type: "tool_use", id: "toolu_flow_checkpoint", name: "mcp__staff__checkpoint", input: { kind: "note", note: "通しの経過" } }], "tool_use");
  await scriptFinish(page);
}

/**
 * 社員と仕事の画面の会話から、レビュー担当に話しかけ、送った発言の吹き出しを返す
 * @param page 画面を開いたページ
 * @param said 発言の本文
 * @returns 送った発言の吹き出し
 */
export async function sayToReviewer(page: Page, said: string): Promise<Locator> {
  await page.goto("/staff/reviewer?tab=talk");
  await page.getByRole("textbox", { name: "レビュー担当への言葉" }).fill(said);
  await page.getByRole("button", { name: "送る" }).click();
  return page.getByRole("log", { name: "レビュー担当との会話" }).getByRole("listitem").filter({ hasText: said });
}

/**
 * 代わりの Claude API に届いた呼び出しに、その文が入っているか
 * @param page 画面を開いたページ
 * @param text 探す文
 * @returns 入っていれば true
 */
export async function claudeReceived(page: Page, text: string): Promise<boolean> {
  return (await (await page.request.get(`${FAKES}/anthropic/__fake/requests`)).text()).includes(text);
}

/** 続けるタスクの題の頭。前の通しが落ちて残した物を探す */
export const CARRY_TITLE = "続けるタスク";

/**
 * 前の通しが落ちて残した、続けるタスクを見送りにする。止めたままのタスクは再開し、社員が持っていれば終わりの返事で終えさせて離れさせてから、残りを見送りにする
 * @param page 画面を開いたページ
 */
export async function dropLeftovers(page: Page): Promise<void> {
  const left = Trees.parse(await (await page.request.get(`/api/v1/nodes?rootId=${PURPOSE}`)).json())
    .data.flatMap(function walk(n: Tree): Tree[] {
      return [n, ...n.children.flatMap(walk)];
    })
    .filter((n) => n.title.startsWith(`${CARRY_TITLE} `));
  const ids = new Set(left.map((n) => n.id));
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  for (const s of state.data.stopped.filter((x) => x.scope === "task" && ids.has(x.target))) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
  const holding = async () => Held.parse(await (await page.request.get("/api/v1/staff")).json()).data.find((s) => s.id === "reviewer")?.nodeId ?? null;
  const held = await holding();
  if (held !== null && ids.has(held)) {
    await scriptFinish(page);
    // 途中で落ちた通しは、待ちを付けたチェックポイントの返事を先に返してから終える
    await expect.poll(holding, { timeout: 240_000 }).not.toBe(held);
  }
  for (const n of left) {
    const { status, version } = NodeDetail.parse(await (await page.request.get(`/api/v1/nodes/${n.id}`)).json()).data;
    if (status === "done" || status === "dropped") continue;
    expect((await page.request.patch(`/api/v1/nodes/${n.id}`, { headers: { Origin: new URL(page.url()).origin }, data: { version, status: "dropped" } })).status()).toBe(200);
  }
}
