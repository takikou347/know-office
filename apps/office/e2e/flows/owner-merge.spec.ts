// main に入れる条件にオーナーの承認があるサービスの通し。レビュー担当が承認したレビューがダッシュボードの承認を待つ物に出て、オーナーがそこから開いて承認すると main が進む
// ゲートウェイの返事は差し替えず、GitHub は手元の代わりの GitHub、レビュー担当の SDK は手元の代わりの Claude API だけを呼ぶ (タスクとレビューの 3.4、GitHub の連携の 3.3)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { seedMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";
import { part } from "./helpers/screen.ts";
import { clockIn, forgetReplies, idleStaff, ownerPasskey, scriptReply } from "./helpers/staff.ts";

/**
 * 通しごとに新しい ID を作る。タスクの出来事は年ごとの記録に残り消さないので、前の通しの出来事と混ぜない
 * @returns UUID v7 の形の ID
 */
function flowId(): string {
  const hex = crypto.randomUUID().replaceAll("-", "");
  return `019a7b00-0000-7${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(6, 18)}`;
}

/** main に入れる条件にオーナーの承認を持つ、この通しだけのサービス。設定は追記だけで消せないので、同じ ID を使い回し、通しの間だけリポジトリを持たせる */
const SERVICE = "019a7b00-0000-7000-8000-0000000003a1";
const SETTING = "019a7b00-0000-7000-8000-0000000003a2";
const NODE = flowId();
const REVIEW_TASK = flowId();
const TITLE = `オーナーが見る勤怠の直し ${NODE.slice(-6)}`;
const REPO = "example/know-office";

const Head = z.object({ data: z.object({ reviewerVerdict: z.string().nullable() }).loose() });
const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });
const Pushed = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const Opened = z.object({ number: z.number().int().positive(), base: z.object({ sha: z.string() }).loose() });
const Requests = z.array(z.object({ route: z.string(), body: z.unknown() }));

/**
 * タスクの状態を読む
 * @param page 画面を開いたページ
 * @param nodeId タスク ID
 * @returns 状態
 */
async function statusOf(page: Page, nodeId: string): Promise<string> {
  return NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status;
}

/**
 * 代わりの GitHub が受けた main を進める要求の本文
 * @param page 画面を開いたページ
 * @returns 本文
 */
async function mainMoves(page: Page): Promise<unknown[]> {
  const want = `PATCH ${new URL(FAKE_GITHUB).pathname}/repos/${REPO}/git/refs/heads/main`;
  return Requests.parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json())
    .filter((r) => r.route === want)
    .map((r) => r.body);
}

/** この通しが置いたタスクとレビューの行を消し、サービスからリポジトリを外す。後の通しは office の初期値の条件でこのリポジトリを入れる */
function forgetSeed(): void {
  seedMain(`DELETE FROM reviews WHERE node_id = '${NODE}'; DELETE FROM nodes WHERE id IN ('${NODE}', '${REVIEW_TASK}'); UPDATE services SET repo = NULL WHERE id = '${SERVICE}';`);
}

test.describe("know-office の中で確認する", () => {
  // 後の通し (設定など) は GitHub をつないでいない前提なので、つないだ物を消して返す
  test.afterEach(() => forgetGitHub());

  test("レビュー担当が承認したレビューを、ダッシュボードの承認を待つ物から開いてオーナーが承認する", async ({ page }) => {
    // レビュー担当の SDK の呼び出しを待つ
    test.setTimeout(180_000);
    await page.goto("/settings");
    await ownerPasskey(page);
    await connectGitHub(page);
    const restore = await clockIn(page, "reviewer");
    // 途中で落ちても、積んだまま残った返事でレビュー担当がほかのタスクを終えないよう、返事を外してから行を消し、勤務の時刻を戻す
    const undo = [() => forgetReplies(page, "reviewer"), () => forgetSeed(), () => restore()];
    await settle(async () => {
      await idleStaff(page, "reviewer");
      // main に入れる条件にオーナーの承認を持つサービスが、このリポジトリを持つ
      seedMain(
        `INSERT INTO services (id, name, kind, stage, repo, staff_id, created_at) VALUES ('${SERVICE}', 'オーナーが見る通しのサービス', 'web_app', 'closed', NULL, 'builder', 1) ON CONFLICT (id) DO NOTHING; ` +
          `INSERT INTO service_settings (id, service_id, key, value, version, by, created_at) VALUES ('${SETTING}', '${SERVICE}', 'mergeWhen', '["checks","reviewer","owner"]', 1, 'owner', 1) ON CONFLICT (id) DO NOTHING; ` +
          `UPDATE services SET repo = '${REPO}' WHERE id = '${SERVICE}';`,
      );
      // 開発担当がブランチに push してプルリクエストを出し、レビュー担当のレビューのタスクが待っている所から始める
      const branch = `ko/${NODE.slice(0, 8)}-owner-merge-${String(Date.now())}`;
      const pushed = await page.request.post(`${FAKE_GITHUB}/__fake/pushes`, { data: { repo: REPO, branch } });
      expect(pushed.status()).toBe(200);
      const { sha } = Pushed.parse(await pushed.json());
      const opened = await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/pulls`, { headers: { Authorization: "Bearer flow-builder" }, data: { title: TITLE, head: branch, base: "main", body: "" } });
      expect(opened.status()).toBe(201);
      const pr = Opened.parse(await opened.json());
      const now = Date.now();
      seedMain(
        "INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES " +
          `('${NODE}', 'task', NULL, 'office', '${TITLE}', NULL, 'build', 'builder', 'review', 0, '${REPO}', '${branch}', ${String(pr.number)}, 'president', ${String(now)}, ${String(now)}), ` +
          `('${REVIEW_TASK}', 'task', NULL, 'office', 'レビュー: ${TITLE}', NULL, 'review', 'reviewer', 'todo', 0, '${REPO}', '${branch}', ${String(pr.number)}, 'builder', ${String(now)}, ${String(now)}); ` +
          "INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, last_seen_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict) VALUES " +
          `('${flowId()}', '${NODE}', '${REPO}', ${String(pr.number)}, '${branch}', '${pr.base.sha}', '${sha}', NULL, '[]', NULL, NULL, NULL);`,
      );
      // main に入れる前に、ルールが main からの変えたファイルを読み、チェックを読み、main を進める。オーナーはレビューで変えたファイルを読む
      await fakeGitHubRoute(page, `GET /repos/${REPO}/compare/main...${sha}`, { files: [{ filename: "src/attendance.ts" }] });
      await fakeGitHubRoute(page, `GET /repos/${REPO}/pulls/${String(pr.number)}/files`, [{ filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 0;" }]);
      await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${sha}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
      await fakeGitHubRoute(page, `PATCH /repos/${REPO}/git/refs/heads/main`, { ref: "refs/heads/main", object: { sha } });
      const movesBefore = (await mainMoves(page)).length;

      // レビュー担当がレビューのタスクを取り、承認する。条件にオーナーの承認があるので、main に入れずにオーナーを待つ
      await scriptReply(page, "reviewer", [{ type: "tool_use", id: "toolu_flow_owner_merge", name: "mcp__staff__review_submit", input: { verdict: "approve", summary: "空の日を 0 にした。未確認の所は無い", headSha: sha } }], "tool_use");
      await scriptReply(page, "reviewer", [{ type: "text", text: "確かめた" }], "end_turn");
      // 手の空いたレビュー担当に、置いたタスクを取らせる
      expect((await page.request.post("/__dev/staff/reviewer/forget-day")).status()).toBe(204);
      await expect.poll(async () => Head.parse(await (await page.request.get(`/api/v1/reviews/${NODE}`)).json()).data.reviewerVerdict, { timeout: 90_000 }).toBe("approve");
      expect(await statusOf(page, NODE)).toBe("review");
      expect((await mainMoves(page)).length).toBe(movesBefore);

      // ダッシュボードの承認を待つ物に出て、そこからレビューを開く
      await page.goto("/");
      const waiting = page.getByRole("list", { name: "承認を待つ物" });
      await waiting.getByRole("link", { name: new RegExp(`main へのマージ: ${TITLE}`) }).click();
      await expect(page).toHaveURL(new RegExp(`/staff/builder/tasks/${NODE}$`));
      await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();

      // オーナーが承認すると、条件がそろって main が進み、承認を待つ物から消える
      await part(page, "判断").getByRole("button", { name: "承認する" }).click();
      await expect.poll(() => statusOf(page, NODE)).toBe("done");
      expect((await mainMoves(page)).slice(movesBefore)).toContainEqual({ sha, force: false });
      await page.goto("/");
      await expect(page.getByRole("list", { name: "承認を待つ物" })).toBeVisible();
      await expect(page.getByRole("list", { name: "承認を待つ物" }).getByText(TITLE)).toBeHidden();
    }, undo);
  });
});
