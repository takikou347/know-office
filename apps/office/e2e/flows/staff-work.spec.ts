// 社員の仕事の始まりの通し。オーナーが目的と組織図の画面でタスクを足して頼み、社員が取り、開発のコンテナの代わりがタスクの開始 (POST /v1/runs) を受ける。ゲートウェイの返事は差し替えず、SDK は手元の代わりの Claude API だけを呼ぶ (社員が考えるの 3.2)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { seedMain } from "./helpers/seed.ts";
import { part, post } from "./helpers/screen.ts";
import { FAKES } from "../helpers/fakes.ts";

/** 通しの置き場の木。目的と組織図の画面の見本の木と分け、見本の進み具合を変えない */
const PURPOSE = "019a7b00-0000-7000-8000-0000000000e1";
const GOAL = "019a7b00-0000-7000-8000-0000000000e2";
const PROJECT = "019a7b00-0000-7000-8000-0000000000e3";

type Tree = { id: string; title: string; children: Tree[] };
const Tree: z.ZodType<Tree> = z
  .object({
    id: z.string(),
    title: z.string(),
    get children() {
      return z.array(Tree);
    },
  })
  .loose();
const Trees = z.object({ data: z.array(Tree) });
const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });
const Runs = z.array(z.object({ staffId: z.string(), nodeId: z.string() }));
const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), stopId: z.string() })) }) });
const StopMade = z.object({ data: z.object({ stopId: z.uuid() }) });

/**
 * 前の通しが止めたままにした社員を再開する。止まった社員はタスクを取らない
 * @param page 画面を開いたページ
 */
async function resumeStaff(page: Page): Promise<void> {
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  for (const s of state.data.stopped.filter((x) => x.scope === "staff")) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
}

/**
 * 社員が持ったタスクを、手で止めて社員から離し、再開して記録を閉じ、見送りにする。代わりのワークスペースはゲートウェイに終わりを送らないので、社員が持ったままになるのを片付ける
 * @param page 画面を開いたページ
 * @param nodeId タスク ID
 */
async function release(page: Page, nodeId: string): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  const made = await page.request.post("/api/v1/guard/stops", { headers, data: { scope: "task", target: nodeId, reason: "通しの片付け" } });
  expect(made.status()).toBe(201);
  const { stopId } = StopMade.parse(await made.json()).data;
  expect(await post(page, `/api/v1/guard/stops/${stopId}/resume`)).toBe(200);
  // 再開でタスクは todo に戻るので、社員が取る前に見送りにする
  seedMain(`UPDATE nodes SET status = 'dropped', version = version + 1 WHERE id = '${nodeId}' AND status = 'todo'`);
}

/**
 * 通しの木を開き、止めたままの社員を再開する
 * @param page 画面を開くページ
 */
async function openTree(page: Page): Promise<void> {
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
async function addTask(page: Page, title: string, assignee: string): Promise<string> {
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
 * 社員がタスクを取り、開発のコンテナの代わりがタスクの開始を受けるのを待つ
 * @param page 画面を開いたページ
 * @param nodeId タスク ID
 */
async function startedBy(page: Page, nodeId: string): Promise<void> {
  await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("doing");
  // 社員 DO は取った後に鎖の外で呼び出しを始め、開発のコンテナの代わりが /v1/runs を受ける
  await expect
    .poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 })
    .toContainEqual({ staffId: "reviewer", nodeId });
}

test("オーナーが画面で頼んだタスクを社員が取り、ワークスペースがタスクの開始を受ける", async ({ page }) => {
  await openTree(page);
  // レビュー担当には見本の todo が無いので、頼んだタスクをすぐ取る。勤務時間外なら呼び出して取る
  const title = `通しのタスク ${String(Date.now())}`;
  const nodeId = await addTask(page, title, "レビュー担当");
  try {
    await startedBy(page, nodeId);
    await page.reload();
    await expect(page.getByText(`タスク: ${title}`)).toBeVisible();
  } finally {
    await release(page, nodeId);
  }
});

test("オーナーが画面でタスクを取り消し、頼む先を後から変える", async ({ page }) => {
  await openTree(page);
  const main = page.getByRole("main");

  const dropped = `取り消すタスク ${String(Date.now())}`;
  const droppedId = await addTask(page, dropped, "まだ頼まない");
  await main.getByRole("button", { name: `${dropped}を変える` }).click();
  await page.getByRole("dialog", { name: `${dropped}を変える` }).getByRole("button", { name: "タスクを取り消す" }).click();
  await expect(page.getByRole("dialog", { name: `${dropped}を変える` })).toBeHidden();
  await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${dropped}` }).last().getByText("見送り")).toBeVisible();
  expect(NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${droppedId}`)).json()).data.status).toBe("dropped");

  // 頼む先の無いタスクは誰も取らず、頼む先を付けるとその社員が取る
  const later = `後から頼むタスク ${String(Date.now())}`;
  const nodeId = await addTask(page, later, "まだ頼まない");
  try {
    await main.getByRole("button", { name: `${later}を変える` }).click();
    const dialog = page.getByRole("dialog", { name: `${later}を変える` });
    await dialog.getByRole("radiogroup", { name: "頼む先" }).getByRole("radio", { name: "レビュー担当" }).click();
    await dialog.getByRole("button", { name: "頼む先を変える" }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${later}` }).last().getByText("頼む先: レビュー担当")).toBeVisible();
    await startedBy(page, nodeId);
  } finally {
    await release(page, nodeId);
  }
});
