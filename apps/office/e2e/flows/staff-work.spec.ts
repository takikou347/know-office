// 社員の仕事の通し。オーナーが目的と組織図の画面でタスクを足して頼み、社員が取り、開発のコンテナの代わりがタスクの開始 (POST /v1/runs) を受け、社員がツールで発言とチェックポイントを伝え、SDK が終えた知らせがゲートウェイに届いてタスクが done になる。ゲートウェイの返事は差し替えず、SDK は手元の代わりの Claude API だけを呼ぶ (社員が考えるの 3.2)
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { seedMain } from "./helpers/seed.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
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
const NodeVersion = z.object({ data: z.object({ version: z.number() }).loose() });
const Runs = z.array(z.object({ staffId: z.string(), nodeId: z.string() }));
const Staff = z.object({ data: z.array(z.object({ id: z.string(), state: z.string() }).loose()) });
const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), stopId: z.string() })) }) });

/** パスキーの仮想の認証器を入れたページ。Chrome は 1 つのページに内蔵の認証器を 1 つしか入れられない */
const withPasskey = new WeakSet<Page>();

/**
 * ページにオーナーのパスキーを 1 度だけ入れる
 * @param page 画面を開くページ
 */
async function ownerPasskey(page: Page): Promise<void> {
  if (withPasskey.has(page)) return;
  await useOwnerPasskey(page);
  withPasskey.add(page);
}

/**
 * 前の通しが止めたままにした社員を再開する。止まった社員はタスクを取らない
 * @param page 画面を開いたページ
 */
async function resumeStaff(page: Page): Promise<void> {
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  for (const s of state.data.stopped.filter((x) => x.scope === "staff")) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
}

/**
 * 設定の画面を開き、勤務の時刻のカードが読めるのを待つ
 * @param page 画面を開くページ
 * @returns カード
 */
async function scheduleCard(page: Page): Promise<Locator> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "勤務の時刻", exact: true }) });
  await expect(box.getByLabel("終わり (日本時間)")).toHaveValue(/^\d\d:\d\d$/);
  return box;
}

/**
 * 設定の画面の勤務の時刻を変える。時間を足す変更はパスキーで確かめる
 * @param page 画面を開くページ。useOwnerPasskey を付けておく
 * @param start 始まり (日本時間)
 * @param end 終わり (日本時間)
 */
async function setSchedule(page: Page, start: string, end: string): Promise<void> {
  const box = await scheduleCard(page);
  await box.getByLabel("始まり (日本時間)").fill(start);
  await box.getByLabel("終わり (日本時間)").fill(end);
  await box.getByLabel("勤務の時刻を変える理由").fill("社員の仕事の通し");
  await box.getByRole("button", { name: "勤務の時刻を変える" }).click();
  await expect(box.getByText(/勤務の時刻を変えました/)).toBeVisible();
}

/**
 * レビュー担当の今の状態を読む
 * @param page 画面を開いたページ
 * @returns 状態
 */
async function reviewerState(page: Page): Promise<string | undefined> {
  return Staff.parse(await (await page.request.get("/api/v1/staff")).json()).data.find((s) => s.id === "reviewer")?.state;
}

/**
 * レビュー担当を勤務の中にする。時間外の呼び出しはチェックポイントで退勤し、タスクを翌日へ続けるため
 * 前に流した時のワークスペースが落ちて待っていれば、止めて再開して作り直させる。勤務の中でなければ、勤務の時刻を一日に広げて出勤させる
 * @param page 画面を開いたページ
 * @returns 元の勤務の時刻に戻す関数。広げなかった時は何もしない
 */
async function clockInReviewer(page: Page): Promise<() => Promise<void>> {
  if ((await reviewerState(page)) === "waiting") {
    const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "staff", target: "reviewer", reason: "社員の仕事の通しの前に作り直す" } });
    expect(stopped.status()).toBe(201);
    await resumeStaff(page);
    await expect.poll(() => reviewerState(page), { timeout: 30_000 }).not.toMatch(/^(waiting|stopped)$/);
  }
  if ((await reviewerState(page)) === "working") return () => Promise.resolve();
  await ownerPasskey(page);
  const box = await scheduleCard(page);
  const was = { start: await box.getByLabel("始まり (日本時間)").inputValue(), end: await box.getByLabel("終わり (日本時間)").inputValue() };
  const restore = () => setSchedule(page, was.start, was.end);
  await setSchedule(page, "00:00", "23:59");
  try {
    // 同じ日に一度退勤した社員はその日にもう出勤しないので、手元の DO を使い回して流し直す時は、開発の道で退勤した日の印を消して出勤させる
    expect((await page.request.post("/__dev/staff/reviewer/forget-day")).status()).toBe(204);
    await expect.poll(() => reviewerState(page)).toBe("working");
  } catch (error) {
    // 出勤できずに落ちても、広げた勤務の時刻を次の通しに残さない
    await restore();
    throw error;
  }
  return restore;
}

/**
 * 代わりの Claude API に、レビュー担当の SDK が受ける終わりの返事を 1 つ積む
 * @param page 画面を開いたページ
 */
async function scriptFinish(page: Page): Promise<void> {
  await scriptReply(page, [{ type: "text", text: "通しのタスクを終えた" }], "end_turn");
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
 * 社員がタスクを取り、開発のコンテナの代わりがタスクの開始を受け、終えた知らせでタスクが done になるのを待つ。社員は終えて離れるので、通しの後に片付けない
 * @param page 画面を開いたページ
 * @param nodeId タスク ID
 */
async function finishedBy(page: Page, nodeId: string): Promise<void> {
  // 社員 DO は取った後に鎖の外で呼び出しを始め、開発のコンテナの代わりが /v1/runs を受ける。すぐ終えるので doing の間は待たない
  await expect
    .poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 })
    .toContainEqual({ staffId: "reviewer", nodeId });
  // SDK が終えると、代わりのワークスペースがゲートウェイの開発の道に終わりを送り、タスクが done になって社員が離れる
  await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status, { timeout: 60_000 }).toBe("done");
}

/**
 * 代わりの Claude API に、レビュー担当の SDK が受ける返事を 1 つ積む
 * @param page 画面を開いたページ
 * @param content 返す中身のブロック
 * @param stopReason 止まった理由
 */
async function scriptReply(page: Page, content: Record<string, unknown>[], stopReason: "tool_use" | "end_turn"): Promise<void> {
  // 開発担当なども同じ時に見本のタスクで SDK を呼ぶので、レビュー担当の作業トークンの呼び出しにだけ返させる
  const res = await page.request.post(`${FAKES}/anthropic/__fake/responses`, { data: { staffId: "reviewer", content, stop_reason: stopReason } });
  expect(res.status()).toBe(204);
}

/**
 * 代わりの Claude API に、レビュー担当が発言し、チェックポイントを伝え、終わりの文で終える返事を順に積む
 * @param page 画面を開いたページ
 * @param said 発言の本文
 */
async function scriptWork(page: Page, said: string): Promise<void> {
  await scriptReply(page, [{ type: "tool_use", id: "toolu_flow_report", name: "mcp__staff__report", input: { body: said } }], "tool_use");
  await scriptReply(page, [{ type: "tool_use", id: "toolu_flow_checkpoint", name: "mcp__staff__checkpoint", input: { kind: "note", note: "通しの経過" } }], "tool_use");
  await scriptFinish(page);
}

test("オーナーが画面で頼んだタスクを社員が取り、発言とチェックポイントを伝えて終え、記録に残る", async ({ page }) => {
  // 勤務の時刻を変え、SDK が 3 度呼ぶのを待つ
  test.slow();
  await openTree(page);
  const restore = await clockInReviewer(page);
  try {
    const said = `通しのタスクを読んだ ${String(Date.now())}`;
    await scriptWork(page, said);
    await page.goto("/goals");
    // レビュー担当には見本の todo が無いので、頼んだタスクをすぐ取る
    const title = `通しのタスク ${String(Date.now())}`;
    const nodeId = await addTask(page, title, "レビュー担当");
    await finishedBy(page, nodeId);

    // タスクの木で済になる
    await page.reload();
    await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: `タスク: ${title}` }).last().getByText("済", { exact: true })).toBeVisible();

    // 社員と仕事の画面の会話に、社員の発言が出る
    await page.goto("/staff/reviewer?tab=talk");
    await expect(page.getByRole("log", { name: "レビュー担当との会話" }).getByText(said)).toBeVisible();

    // タスクの詳細の作業の流れに、始めた、チェックポイント、終えたが出る
    await page.goto(`/staff/reviewer/tasks/${nodeId}`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    const flow = part(page, "作業の流れ");
    for (const kind of ["started", "checkpoint", "finished"]) await expect(flow.getByText(kind, { exact: true })).toBeVisible();
  } finally {
    await restore();
  }
});

const Created = z.object({ data: z.object({ id: z.string() }).loose(), meta: z.object({ traceId: z.string() }).loose() }).loose();

test.describe("気付く", () => {
  test("1 本の流れで追う", async ({ page }) => {
    // オーナーが頼んだタスクを社員が取り、ワークスペースが発言して終えるまでを待ち、記録の画面で頼んだ要求をたどる
    test.slow();
    await ownerPasskey(page);
    await openTree(page);
    const restore = await clockInReviewer(page);
    try {
      const said = `流れを追う発言 ${String(Date.now())}`;
      await scriptWork(page, said);
      const title = `流れを追うタスク ${String(Date.now())}`;
      // オーナーの操作をゲートウェイの API に送り、返事の meta から traceId を読む。画面からの足し方は上の通しで確かめる (仮想の認証器を入れたページは、画面の要求の本文を読めない)
      const res = await page.request.post("/api/v1/nodes", {
        headers: { Origin: new URL(page.url()).origin },
        data: { kind: "task", parentId: PROJECT, scope: "office", title, body: "流れを追う", taskKind: "build", assignee: "reviewer", repo: "example/know-office" },
      });
      expect(res.status()).toBe(201);
      const created = Created.parse(await res.json());
      const nodeId = created.data.id;
      const traceId = created.meta.traceId;
      await finishedBy(page, nodeId);

      await page.goto(`/records?trace=${traceId}`);
      const trail = part(page, "要求をたどる");
      await trail.getByRole("button", { name: "パスキーで確かめて記録を開く" }).click();
      const table = trail.getByRole("region", { name: "要求の記録" }).getByRole("table");
      // ゲートウェイ (オーナーが足した)、社員 DO (呼び出しの作業トークンを出した)、ワークスペース (社員の発言) が 1 つの流れに並ぶ
      await expect(table.getByRole("row", { name: new RegExp(`監査ログ.*owner が node\\.create \\(${nodeId}\\)`) })).toBeVisible();
      await expect(table.getByRole("row", { name: /監査ログ.*system が ticket\.issue/ })).toBeVisible();
      await expect(table.getByRole("row", { name: new RegExp(`会話.*reviewer の発言: ${said}`) })).toBeVisible();
    } finally {
      await restore();
    }
  });
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
  await scriptFinish(page);
  await main.getByRole("button", { name: `${later}を変える` }).click();
  const dialog = page.getByRole("dialog", { name: `${later}を変える` });
  await dialog.getByRole("radiogroup", { name: "頼む先" }).getByRole("radio", { name: "レビュー担当" }).click();
  await dialog.getByRole("button", { name: "頼む先を変える" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${later}` }).last().getByText("頼む先: レビュー担当")).toBeVisible();
  await finishedBy(page, nodeId);
});

test("ほかで先に頼む先が変わっていたら、木の上に知らせて今の頼む先を出す", async ({ page }) => {
  await openTree(page);
  const main = page.getByRole("main");
  const title = `先に変わるタスク ${String(Date.now())}`;
  const nodeId = await addTask(page, title, "まだ頼まない");
  // 直に頼む先をレビュー担当に変えると、レビュー担当が取って終える
  await scriptFinish(page);
  await main.getByRole("button", { name: `${title}を変える` }).click();
  const dialog = page.getByRole("dialog", { name: `${title}を変える` });
  await dialog.getByRole("radiogroup", { name: "頼む先" }).getByRole("radio", { name: "社長" }).click();
  // 画面が読んだ後に、ゲートウェイへ直に頼む先を変えて版を進める
  const { version } = NodeVersion.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data;
  const moved = await page.request.patch(`/api/v1/nodes/${nodeId}`, { headers: { Origin: new URL(page.url()).origin }, data: { version, assignee: "reviewer" } });
  expect(moved.status()).toBe(200);
  await dialog.getByRole("button", { name: "頼む先を変える" }).click();
  await expect(main.getByText("ほかで先に変わっていたので読み直しました")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${title}` }).last().getByText("頼む先: レビュー担当")).toBeVisible();
  await finishedBy(page, nodeId);
});
