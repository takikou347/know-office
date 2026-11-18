// レビューの繰り返しの通し。オーナーが変更を読んで行に指摘を書き、開発担当が直して push し、同じプルリクエストで出し直すと、レビュー担当がもう一度確かめ、オーナーは前に見た所からの差だけを読んで承認し、main が進む
// ゲートウェイの返事は差し替えず、GitHub は手元の代わりの GitHub、社員の SDK は手元の代わりの Claude API だけを呼ぶ (タスクとレビューの 3.1、3.4、3.6)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { readMain, seedMain } from "./helpers/seed.ts";
import { part, post } from "./helpers/screen.ts";
import { clockIn, forgetReplies, idleStaff, ownerPasskey, scriptReply } from "./helpers/staff.ts";

/**
 * 通しごとに新しい ID を作る。タスクの出来事は年ごとの記録に残り消さないので、前の通しの出来事と混ぜない
 * @returns UUID v7 の形の ID
 */
function flowId(): string {
  const hex = crypto.randomUUID().replaceAll("-", "");
  return `019a7b00-0000-7${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(6, 18)}`;
}

/** 通しの開発担当のタスクとレビューの行 */
const NODE = flowId();
const REVIEW = flowId();
const TITLE = "通しで勤怠の空の日を直す";
const REPO = "example/know-office";

const Head = z.object({ data: z.object({ headSha: z.string(), lastSeenSha: z.string().nullable(), reviewerVerdict: z.string().nullable() }).loose() });
const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });
const Pushed = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const Opened = z.object({ number: z.number().int().positive(), base: z.object({ sha: z.string() }).loose() });
const Requests = z.array(z.object({ route: z.string(), body: z.unknown() }));

/**
 * この通しが作ったタスクとレビューの行を消す。review_notes は追記だけなので残す (消したレビューの ID にしか当たらない)。代わりの GitHub は起こすたびにプルリクエストの番号と先を同じ順に振るので、残すと次の通しの同じ番号の通知やレビューが前の行に当たる
 * @param held 社員が持っている (doing の) タスクも消すか。持ったまま消すと社員が離れられないので、手を空けた後だけ消す
 */
function forgetLoop(held: boolean): void {
  const rows = `repo = '${REPO}' AND branch LIKE 'ko/%-review-loop-%'${held ? "" : " AND status <> 'doing'"}`;
  seedMain(
    `DELETE FROM reviews WHERE node_id IN (SELECT id FROM nodes WHERE ${rows}); ` +
      `DELETE FROM nodes WHERE ${rows};`,
  );
}

const Ids = z.array(z.object({ id: z.string() }));
const Stopped = z.object({ data: z.object({ stopId: z.string() }) });

/**
 * 開発担当の待ちと作業中のタスク (見本の木のタスクなど) を、通しの間だけ止める。出勤させるとすぐ取って SDK を呼び、終えさせると見本の値が変わるので、止めて離れさせる
 * @param page 画面を開いたページ
 * @param stops 止めた記録の ID を足す先。途中で落ちても、止めた物を終わりに再開できる
 */
async function stopBuilderTasks(page: Page, stops: string[]): Promise<void> {
  const ids = Ids.parse(readMain("SELECT id FROM nodes WHERE assignee = 'builder' AND status IN ('todo', 'doing') AND (branch IS NULL OR branch NOT LIKE 'ko/%-review-loop-%')"));
  for (const { id } of ids) {
    const res = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "task", target: id, reason: "レビューの流れの通しの間だけ止める" } });
    expect(res.status()).toBe(201);
    stops.push(Stopped.parse(await res.json()).data.stopId);
  }
}

/**
 * 止めたタスクを再開し、待ちに戻す
 * @param page 画面を開いたページ
 * @param stops stopBuilderTasks が止めた記録の ID
 */
async function resumeBuilderTasks(page: Page, stops: string[]): Promise<void> {
  for (const stopId of stops) expect(await post(page, `/api/v1/guard/stops/${stopId}/resume`)).toBe(200);
}

/**
 * 開発担当の push と同じく、代わりの GitHub でブランチの先を進める。開いたプルリクエストがあれば synchronize の通知がゲートウェイに届く
 * @param page 画面を開いたページ
 * @param branch ブランチ
 * @returns 新しい先
 */
async function pushTo(page: Page, branch: string): Promise<string> {
  const res = await page.request.post(`${FAKE_GITHUB}/__fake/pushes`, { data: { repo: REPO, branch } });
  expect(res.status()).toBe(200);
  return Pushed.parse(await res.json()).sha;
}

/**
 * レビューの概要を読む
 * @param page 画面を開いたページ
 * @returns 今の先、前に見た先、レビュー担当の判断
 */
async function headOf(page: Page): Promise<z.infer<typeof Head>["data"]> {
  return Head.parse(await (await page.request.get(`/api/v1/reviews/${NODE}`)).json()).data;
}

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
 * 代わりの GitHub が受けた要求のうち、道が合う物の本文
 * @param page 画面を開いたページ
 * @param route 「メソッド 道」。道は GitHub の API と同じ /repos/... の形
 * @returns 本文
 */
async function received(page: Page, route: string): Promise<unknown[]> {
  const [method, path] = route.split(" ");
  const want = `${method ?? ""} ${new URL(FAKE_GITHUB).pathname}${path ?? ""}`;
  return Requests.parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json())
    .filter((r) => r.route === want)
    .map((r) => r.body);
}

test.describe("別のモデルによる確認", () => {
  // 後の通し (設定など) は GitHub をつないでいない前提なので、つないだ物を消して返す
  test.afterEach(() => forgetGitHub());

  test("指摘を直して出し直すと、レビュー担当が同じプルリクエストで確かめ直し、オーナーは前に見た所からの差を読んで承認する", async ({ page }) => {
    // 社員 2 人の SDK の呼び出しと、出し直しの前に置いた間を待つ
    test.setTimeout(240_000);
    await page.goto("/settings");
    await ownerPasskey(page);
    await connectGitHub(page);
    const restore = await clockIn(page, "reviewer");
    // 開発担当を出勤させるために広げた勤務の時刻も戻す。後から広げた方を先に戻し、最後に始めの時刻へ戻す。出勤させる前に落ちた時は始めの時刻へ 2 度戻すだけ
    let restoreBuilder = restore;
    const stops: string[] = [];
    try {
      await stopBuilderTasks(page, stops);
      // 開発担当も出勤させ、前の通しのタスクを離れて手が空くのを待つ
      restoreBuilder = await clockIn(page, "builder");
      await idleStaff(page, "builder");
      // 前の通しが落ちて残した行を消し、レビュー担当の手を空けてから、持っていた行も消す
      forgetLoop(false);
      await idleStaff(page, "reviewer");
      forgetLoop(true);
      // 開発担当がブランチに push してプルリクエストを出し、レビュー担当が一度承認した所から始める
      const branch = `ko/${NODE.slice(0, 8)}-review-loop-${String(Date.now())}`;
      const first = await pushTo(page, branch);
      const opened = await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/pulls`, { headers: { Authorization: "Bearer flow-builder" }, data: { title: TITLE, head: branch, base: "main", body: "" } });
      expect(opened.status()).toBe(201);
      const pr = Opened.parse(await opened.json());
      const pullsOpened = (await received(page, `POST /repos/${REPO}/pulls`)).length;
      const now = Date.now();
      seedMain(
        "INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES " +
          `('${NODE}', 'task', NULL, 'office', '${TITLE}', NULL, 'build', 'builder', 'review', 0, '${REPO}', '${branch}', ${String(pr.number)}, 'president', ${String(now)}, ${String(now)}); ` +
          "INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, last_seen_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict) VALUES " +
          `('${REVIEW}', '${NODE}', '${REPO}', ${String(pr.number)}, '${branch}', '${pr.base.sha}', '${first}', NULL, '[]', '空の日の勤怠を表に出した', 'approve', NULL);`,
      );
      await fakeGitHubRoute(page, `GET /repos/${REPO}/pulls/${String(pr.number)}/files`, [
        { filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" },
        { filename: "src/format.ts", status: "modified", patch: "@@ -1 +1 @@\n-const f = 1;\n+const f = 2;" },
      ]);
      // 出し直しの前に、ルールが main からの変えたファイルを読む
      await fakeGitHubRoute(page, `GET /repos/${REPO}/compare/main...${branch}`, { files: [{ filename: "src/attendance.ts" }, { filename: "src/format.ts" }] });

      // オーナーがレビューを開くと、今の先まで読んだ印が付く
      await page.goto(`/staff/builder/tasks/${NODE}`);
      await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
      await expect.poll(async () => (await headOf(page)).lastSeenSha).toBe(first);

      // 開発担当の SDK は、指摘を受けて直した後にプルリクエストを出し直す。直して push し、レビュー担当の返事を積むまでの間を置いて返す。積む前にレビュー担当が呼ぶと、返事が無くて走りが落ちる
      await scriptReply(page, "builder", [{ type: "tool_use", id: "toolu_flow_pr_open", name: "mcp__staff__pr_open", input: { name: "review-loop", title: TITLE, body: "空の日を 0 にした" } }], "tool_use", 30_000);
      await scriptReply(page, "builder", [{ type: "text", text: "出し直した" }], "end_turn");

      // オーナーが行に指摘を書くと、開発担当のタスクに戻る
      const changes = part(page, "変更");
      await changes.getByRole("button", { name: "src/attendance.ts の 1 行目に一言を付ける" }).click();
      await changes.getByRole("textbox", { name: "src/attendance.ts の 1 行目への指摘" }).fill("空の日は 0 を出す");
      await changes.getByRole("button", { name: "指摘を送る" }).click();
      await expect(page.getByText("src/attendance.ts の 1 行目に指摘を書き、作る役に戻しました")).toBeVisible();
      await expect.poll(() => statusOf(page, NODE)).toMatch(/^(todo|doing)$/);

      // 開発担当が直して push すると、先が進み、前の承認が消える
      const fixed = await pushTo(page, branch);
      await fakeGitHubRoute(page, `GET /repos/${REPO}/compare/${first}...${fixed}`, { files: [{ filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 2;\n+const a = 0;" }] });
      await expect.poll(async () => headOf(page)).toMatchObject({ headSha: fixed, reviewerVerdict: null });
      await fakeGitHubRoute(page, `GET /repos/${REPO}/compare/main...${fixed}`, { files: [{ filename: "src/attendance.ts" }, { filename: "src/format.ts" }] });
      // レビュー担当が承認した時はチェックがまだ終わっておらず、main に入れずに待つ
      await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${fixed}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "in_progress", conclusion: null }] });
      await fakeGitHubRoute(page, `PATCH /repos/${REPO}/git/refs/heads/main`, { ref: "refs/heads/main", object: { sha: fixed } });
      await scriptReply(page, "reviewer", [{ type: "tool_use", id: "toolu_flow_review", name: "mcp__staff__review_submit", input: { verdict: "approve", summary: "空の日を 0 にした。未確認の所は無い", headSha: fixed } }], "tool_use");
      await scriptReply(page, "reviewer", [{ type: "text", text: "確かめ直した" }], "end_turn");

      // 開発担当が同じプルリクエストで出し直すと、レビュー担当がもう一度確かめて承認する
      await expect.poll(async () => headOf(page), { timeout: 90_000 }).toMatchObject({ headSha: fixed, reviewerVerdict: "approve" });
      expect(await statusOf(page, NODE)).toBe("review");
      // 出し直しは GitHub に新しいプルリクエストを出さない
      expect(await received(page, `POST /repos/${REPO}/pulls`)).toHaveLength(pullsOpened);

      // オーナーが開き直すと、前に見た所からの差だけを読める
      await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${fixed}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
      await page.reload();
      await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
      await expect(part(page, "要点").getByText("空の日を 0 にした。未確認の所は無い")).toBeVisible();
      await changes.getByRole("radio", { name: "前に見た所からの差" }).click();
      await expect(changes.getByText("src/format.ts")).toBeHidden();
      await expect(changes.getByText("const a = 0;")).toBeVisible();

      // オーナーが承認すると、確かめた先まで main が進む
      await part(page, "判断").getByRole("button", { name: "承認する" }).click();
      await expect(page.getByText("承認を出し、GitHub にも写しました")).toBeVisible();
      await expect.poll(() => statusOf(page, NODE)).toBe("done");
      expect(await received(page, `PATCH /repos/${REPO}/git/refs/heads/main`)).toContainEqual({ sha: fixed, force: false });
    } finally {
      // 途中で落ちても、積んだまま残った返事で開発担当が見本のタスクを終えないよう、返事を外してから止めたタスクを再開する
      forgetLoop(false);
      await forgetReplies(page, "builder");
      await forgetReplies(page, "reviewer");
      await resumeBuilderTasks(page, stops);
      try {
        await restoreBuilder();
      } finally {
        await restore();
      }
    }
  });
});
