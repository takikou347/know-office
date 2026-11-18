// 承認の後にチェックを待つタスクの通し。チェックの終わりの通知で main に入る、チェックが落ちてオーナーに知らせが出る、GitHub で出たオーナーの可で main に入る
// ゲートウェイの返事は差し替えず、通知は手元の代わりの GitHub が App の通知の秘密で署名して送る (タスクとレビューの 3.1 の 5、3.5)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub, forgetGitHubRoute } from "./helpers/github.ts";
import { noticeBar, readNoticesTitled } from "./helpers/notice-bar.ts";
import { seedMain } from "./helpers/seed.ts";
import { ownerPasskey } from "./helpers/staff.ts";

const REPO = "example/know-office";

const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });
const Pushed = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const Opened = z.object({ number: z.number().int().positive(), base: z.object({ sha: z.string() }).loose() });
const Requests = z.array(z.object({ route: z.string(), body: z.unknown() }));

/**
 * 通しごとに新しい ID を作る。タスクの出来事は年ごとの記録に残り消さないので、前の通しの出来事と混ぜない
 * @returns UUID v7 の形の ID
 */
function flowId(): string {
  const hex = crypto.randomUUID().replaceAll("-", "");
  return `019a7b00-0000-7${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(6, 18)}`;
}

/** 置いたタスクと、代わりの GitHub に置いた返事 */
type Waiting = { node: string; title: string; sha: string; pr: number; routes: string[] };

/**
 * 開発担当がブランチに push して PR を出し、レビュー担当がチェックの走っている間に承認した所を置く。社員の承認は画面から作れないので手元の D1 に置く
 * @param page 画面を開いたページ
 * @param checks 先のチェックの状態と結果
 * @returns 置いたタスク
 */
async function approvedWhileRunning(page: Page, checks: { status: string; conclusion: string | null }): Promise<Waiting> {
  const node = flowId();
  const title = `チェックを待つ勤怠の直し ${node.slice(-6)}`;
  const branch = `ko/${node.slice(0, 8)}-merge-checks-${String(Date.now())}`;
  const pushed = await page.request.post(`${FAKE_GITHUB}/__fake/pushes`, { data: { repo: REPO, branch } });
  expect(pushed.status()).toBe(200);
  const { sha } = Pushed.parse(await pushed.json());
  const opened = await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/pulls`, { headers: { Authorization: "Bearer flow-builder" }, data: { title, head: branch, base: "main", body: "" } });
  expect(opened.status()).toBe(201);
  const pr = Opened.parse(await opened.json());
  const now = Date.now();
  seedMain(
    "INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES " +
      `('${node}', 'task', NULL, 'office', '${title}', NULL, 'build', 'builder', 'review', 0, '${REPO}', '${branch}', ${String(pr.number)}, 'president', ${String(now)}, ${String(now)}); ` +
      "INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, checks, reviewer_summary, reviewer_verdict) VALUES " +
      `('${flowId()}', '${node}', '${REPO}', ${String(pr.number)}, '${branch}', '${pr.base.sha}', '${sha}', '[]', '空の日を 0 にした', 'approve');`,
  );
  // main に入れる前に、ルールが main からの変えたファイルを読み、チェックを読み、main を進める
  const routes = [`GET /repos/${REPO}/compare/main...${sha}`, `GET /repos/${REPO}/commits/${sha}/check-runs`, `PATCH /repos/${REPO}/git/refs/heads/main`];
  await fakeGitHubRoute(page, routes[0] ?? "", { files: [{ filename: "src/attendance.ts" }] });
  await fakeGitHubRoute(page, routes[1] ?? "", { total_count: 1, check_runs: [{ name: "verify", ...checks }] });
  await fakeGitHubRoute(page, routes[2] ?? "", { ref: "refs/heads/main", object: { sha } });
  return { node, title, sha, pr: pr.number, routes };
}

/**
 * 置いたタスクとレビューの行、代わりの GitHub に置いた返事を消す
 * @param page 画面を開いたページ
 * @param w 置いたタスク。置く前に落ちたら null
 */
async function forget(page: Page, w: Waiting | null): Promise<void> {
  if (w === null) return;
  seedMain(`DELETE FROM reviews WHERE node_id = '${w.node}'; DELETE FROM nodes WHERE id = '${w.node}';`);
  for (const route of w.routes) await forgetGitHubRoute(page, route);
}

/**
 * 代わりの GitHub に、App の通知を送らせる
 * @param page 画面を開いたページ
 * @param event 種類
 * @param payload 本文。installation は代わりの GitHub が付ける
 */
async function sendHook(page: Page, event: string, payload: Record<string, unknown>): Promise<void> {
  const res = await page.request.post(`${FAKE_GITHUB}/__fake/hooks`, { data: { event, payload: { ...payload, repository: { full_name: REPO } } } });
  expect(res.status()).toBe(204);
}

/**
 * タスクの状態を読む
 * @param page 画面を開いたページ
 * @param node タスク ID
 * @returns 状態
 */
async function statusOf(page: Page, node: string): Promise<string> {
  return NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${node}`)).json()).data.status;
}

/**
 * 代わりの GitHub が受けた main を進める要求のうち、先が合う物の数
 * @param page 画面を開いたページ
 * @param sha 先
 * @returns 数
 */
async function mainMoves(page: Page, sha: string): Promise<number> {
  const want = `PATCH ${new URL(FAKE_GITHUB).pathname}/repos/${REPO}/git/refs/heads/main`;
  return Requests.parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json()).filter((r) => r.route === want && JSON.stringify(r.body).includes(sha)).length;
}

/**
 * 開発担当のタスクの一覧で、タスクが済みになっているのを見る
 * @param page 画面を開いたページ
 * @param title タスクの題
 */
async function seeDone(page: Page, title: string): Promise<void> {
  await page.goto("/staff/builder?tab=tasks");
  const row = page.getByRole("main").locator("li", { hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("済", { exact: true })).toBeVisible();
}

test.describe("通知を受ける", () => {
  // 後の通し (設定など) は GitHub をつないでいない前提なので、つないだ物を消して返す
  test.afterEach(() => forgetGitHub());

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
    await ownerPasskey(page);
    await connectGitHub(page);
  });

  test("承認の後にチェックが通ったら、通知で main に入れる", async ({ page }) => {
    let w: Waiting | null = null;
    try {
      w = await approvedWhileRunning(page, { status: "completed", conclusion: "success" });
      await sendHook(page, "check_suite", { action: "completed", check_suite: { head_sha: w.sha, conclusion: "success" } });
      await expect.poll(() => statusOf(page, w?.node ?? "")).toBe("done");
      expect(await mainMoves(page, w.sha)).toBe(1);
      await seeDone(page, w.title);
    } finally {
      await forget(page, w);
    }
  });

  test("承認の後にチェックが落ちたら、review のまま、オーナーに 1 回だけ知らせる", async ({ page }) => {
    let w: Waiting | null = null;
    let title = "";
    try {
      w = await approvedWhileRunning(page, { status: "completed", conclusion: "failure" });
      title = `承認の後にチェックが落ちた (${w.node.slice(0, 8)} ${w.sha.slice(0, 8)})`;
      await sendHook(page, "check_run", { action: "completed", check_run: { name: "verify", status: "completed", conclusion: "failure", head_sha: w.sha } });
      // オーナーは上部の帯で知らせを読み、レビューの画面で差し戻せる
      await page.goto("/");
      await expect(await noticeBar(page, "status", title, 30_000)).toBeVisible();
      expect(await statusOf(page, w.node)).toBe("review");
      expect(await mainMoves(page, w.sha)).toBe(0);
    } finally {
      if (title !== "") await readNoticesTitled(page, title);
      await forget(page, w);
    }
  });

  test("GitHub で出たオーナーの可で、条件がそろえば main に入れる", async ({ page }) => {
    let w: Waiting | null = null;
    try {
      // チェックの終わりの通知は届かなかったが、チェックは通っている
      w = await approvedWhileRunning(page, { status: "completed", conclusion: "success" });
      const user = { login: "example", type: "User" };
      await sendHook(page, "pull_request_review", {
        action: "submitted",
        review: { id: Date.now() % 1_000_000_000, state: "approved", body: "よい", user, author_association: "OWNER", commit_id: w.sha },
        pull_request: { number: w.pr },
        sender: user,
      });
      await expect.poll(() => statusOf(page, w?.node ?? "")).toBe("done");
      expect(await mainMoves(page, w.sha)).toBe(1);
      await seeDone(page, w.title);
    } finally {
      await forget(page, w);
    }
  });
});
