// 案からサービスに進める通し。試作の案の子 Issue の PR がオーナーの承認で main に入ると、GitHub の子と親の Issue が閉じ、サービスの Issue のタブが済みを出し、「サービスに進められる」知らせが出て、オーナーがサービスに進める (開発の回し方の 3.7)。ゲートウェイの返事は差し替えず、GitHub は開発の代わりの物を使う
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { findTaskId, giveBackBuilderTasks, prototypeService, releaseBuilderTask, releaseReviewTask, REPO, setAsideBuilderTasks } from "./helpers/dev-loop.ts";
import { readNoticesTitled } from "./helpers/notice-bar.ts";
import { Held, openTree } from "./helpers/staff-work.ts";
import { clockIn, scriptReply } from "./helpers/staff.ts";
import { restoreSeedServices, seedMain } from "./helpers/seed.ts";
import { move } from "./helpers/services.ts";

test.afterEach(() => {
  forgetGitHub();
  restoreSeedServices();
});

test("子 Issue が入って閉じると、親も閉じ、サービスに進められると知らせ、オーナーがサービスに進める", async ({ page }) => {
  test.slow();
  const { serviceId, title } = await prototypeService(page, "進める案");
  // 前の通しが残した読んでいない鍵と上限の通知は、どの社員の呼び出しも止めるので、先に読んだ事にする
  seedMain(`UPDATE notices SET read_at = ${String(Date.now())} WHERE kind IN ('sdk_auth_failed', 'claude_spend_limit') AND read_at IS NULL`);
  // 前の通しが開発担当に残したタスク (見本のタスクや設計書のタスク) は、先に取られて積んだ返事を使われるので、通しの間だけ開発担当から外し、終わりに戻す。
  // 持って呼び出し中の物は、止めて再開しても続きから呼ぶので、見送りにして離させる
  const aside = await setAsideBuilderTasks(page);
  try {
    // 前の通しが落ちて消したタスクを持ったままの開発担当は、止めて再開して作り直させる
    const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "staff", target: "builder", reason: "開発の回し方の通しの前に作り直す" } });
    expect(stopped.status()).toBe(201);
    // 子 Issue のタスクの親にする、通しの木 (開発担当の作業の開始が祖先の木を読む)。止めた社員もここで再開する
    await openTree(page);
    let restoreSchedule: (() => Promise<void>) | null = null;
    const ids = { task: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, dev: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, parent: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` };
    const github = { headers: { authorization: "Bearer e2e", "user-agent": "know-office-e2e" } };
    const ref = `${FAKE_GITHUB}/repos/${REPO}/git/refs/heads`;

    // 代わりの GitHub に、main の先と、その上に出す前のブランチの先を置く。main は前の通しが進めているので、前の先を覚え、終わりに戻す
    const commit = async (parents: string[]): Promise<string> => {
      const res = await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/git/commits`, { ...github, data: { message: "m", tree: "1".repeat(40), parents } });
      if (!res.ok()) throw new Error(`コミットを置けない: ${String(res.status())} ${await res.text()}`);
      return z.object({ sha: z.string() }).parse(await res.json()).sha;
    };
    const before = await page.request.get(`${FAKE_GITHUB}/repos/${REPO}/git/ref/heads/main`, github);
    const previous = before.ok() ? z.object({ object: z.object({ sha: z.string() }) }).parse(await before.json()).object.sha : null;
    const base = await commit([]);
    const head = await commit([base]);
    const branch = `ko/019a7b00-make${crypto.randomUUID().slice(0, 6)}`;
    const put = async (name: string, sha: string) => expect((await page.request.patch(`${ref}/${name}`, { ...github, data: { sha, force: true } })).status()).toBe(200);
    const issue = z.object({ number: z.number() }).parse(await (await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/issues`, { ...github, data: { title: "動画を作る", body: "設計書: 詳細設計 1-video の要件「動画を作る」", labels: ["feature"] } })).json()).number;
    const parentIssue = z.object({ number: z.number() }).parse(await (await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/issues`, { ...github, data: { title: "動画", body: "設計書: 詳細設計 1-video の機能「動画」", labels: [] } })).json()).number;
    await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${head}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });

    // 子 Issue のタスクと行は、設計書から Issue を立てる道 (社長の issue_plan) の結果なので、手元の D1 に置く。PR は置かず、開発担当に出させる
    const now = String(Date.now());
    const mark = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, repo, issue_number, source, assignee, task_kind, version, created_by, created_at, updated_at) VALUES ('${ids.task}', 'task', '019a7b00-0000-7000-8000-0000000000e3', '${serviceId}', '#${String(issue)} 動画を作る', 'todo', 0, '${REPO}', ${String(issue)}, 'issue:${String(issue)}', NULL, 'build', 1, 'system', ${now}, ${now})`,
    );
    const parentMark = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    seedMain(
      `INSERT INTO dev_issues (id, service_id, repo, number, issue_id, kind, feature, requirement, req_hash, mark_key, state, created_at) VALUES ('${ids.parent}', '${serviceId}', '${REPO}', ${String(parentIssue)}, ${String(parentIssue)}, 'parent', '1-video', NULL, NULL, '${parentMark}', 'open', ${now})`,
    );
    seedMain(
      `INSERT INTO dev_issues (id, service_id, repo, number, issue_id, parent_number, kind, feature, requirement, req_hash, issue_kind, paths, heads, mark_key, state, created_at) VALUES ('${ids.dev}', '${serviceId}', '${REPO}', ${String(issue)}, ${String(issue)}, ${String(parentIssue)}, 'child', '1-video', '動画を作る', 'e2e', 'feature', '["src/a.ts"]', '["src/a.ts"]', '${mark}', 'open', ${now})`,
    );

    try {
      restoreSchedule = await clockIn(page, "builder");
      await put("main", base);
      await put(branch, head);
      // 代わりの Claude が、開発担当に pr_open を呼ばせて終える。ブランチ名は ko/<タスク ID の頭 8 字>-<name>
      const name = branch.slice("ko/019a7b00-".length);
      await scriptReply(page, "builder", [{ type: "tool_use", id: "toolu_flow_pr_open", name: "mcp__staff__pr_open", input: { name, title: "動画を作る", body: "動画を作った" } }], "tool_use");
      await scriptReply(page, "builder", [{ type: "text", text: "PR を出した" }], "end_turn");
      // 開発担当に頼むと、開発担当がタスクを取って始める
      expect((await page.request.patch(`/api/v1/nodes/${ids.task}`, { headers: { Origin: new URL(page.url()).origin }, data: { version: 1, assignee: "builder" } })).status()).toBe(200);

      // タスクがレビューに移り、代わりの GitHub が受けた PR の本文の最後に Closes が付いている
      const status = async () => z.object({ data: z.object({ status: z.string() }).loose() }).parse(await (await page.request.get(`/api/v1/nodes/${ids.task}`)).json()).data;
      await expect.poll(async () => (await status()).status, { timeout: 60_000 }).toBe("review");
      const opened = z.object({ data: z.object({ events: z.array(z.object({ kind: z.string(), detail: z.record(z.string(), z.unknown()) }).loose()) }).loose() }).parse(await (await page.request.get(`/api/v1/nodes/${ids.task}`)).json()).data.events.find((e) => e.kind === "pr_opened");
      const pr = z.number().parse(opened?.detail["prNumber"]);
      const body = z.object({ body: z.string() }).parse(await (await page.request.get(`${FAKE_GITHUB}/repos/${REPO}/pulls/${String(pr)}`, github)).json()).body;
      expect(body.endsWith(`Closes #${String(issue)}`)).toBe(true);

      // レビュー担当の承認は社員のツールなので手元の D1 に置く。オーナーが承認すると、チェックとレビュー担当の承認がそろっているので、main が進み、Issue が閉じる
      seedMain(`UPDATE reviews SET reviewer_verdict = 'approve', reviewer_summary = '確かめた' WHERE node_id = '${ids.task}'`);
      const verdict = await page.request.post(`/api/v1/reviews/${ids.task}/verdict`, { data: { verdict: "approve", body: "よい", baseSha: head }, headers: { Origin: new URL(page.url()).origin } });
      expect(verdict.status()).toBe(200);
      await expect
        .poll(async () => z.object({ state: z.string(), state_reason: z.string().nullable() }).parse(await (await page.request.get(`${FAKE_GITHUB}/repos/${REPO}/issues/${String(issue)}`, github)).json()), { timeout: 20_000 })
        .toEqual({ state: "closed", state_reason: "completed" });
      expect((await status()).status).toBe("done");
      // 親の Issue も、completed で閉じる
      await expect
        .poll(async () => z.object({ state: z.string(), state_reason: z.string().nullable() }).parse(await (await page.request.get(`${FAKE_GITHUB}/repos/${REPO}/issues/${String(parentIssue)}`, github)).json()), { timeout: 20_000 })
        .toEqual({ state: "closed", state_reason: "completed" });
      // サービスの Issue のタブが、親と子の済みを出す
      await page.goto(`/services/${serviceId}`);
      const main = page.getByRole("main");
      await main.getByRole("tab", { name: "Issue" }).click();
      const panel = main.getByRole("tabpanel", { name: "Issue" });
      await expect(panel.getByText("1-video", { exact: false }).first()).toBeVisible();
      await expect(panel.getByText("1 / 1 済")).toBeVisible();
      await expect(panel.getByText("サービスに進められる", { exact: false }).first()).toBeVisible();
      // 「サービスに進められる」知らせが 1 つ出る。読んで、サービスに進める
      const Notices = z.object({ data: z.array(z.object({ title: z.string(), readAt: z.string().nullable() }).loose()) });
      const readyTitle = `${title} をサービスに進められる`;
      await expect
        .poll(async () => Notices.parse(await (await page.request.get("/api/v1/notices?limit=100")).json()).data.filter((n) => n.title === readyTitle).length, { timeout: 20_000 })
        .toBe(1);
      await readNoticesTitled(page, readyTitle);
      await move(page, "サービスにする", "子の Issue がすべて入った");
      await expect(main.getByText("サービス", { exact: true }).first()).toBeVisible();
    } finally {
      try {
        // 後の通しに残さない。main は前の先に戻し (前が無ければ消し)、出したブランチも消す
        if (previous === null) await page.request.delete(`${ref}/main`, github);
        else await page.request.patch(`${ref}/main`, { ...github, data: { sha: previous, force: true } });
        await page.request.delete(`${ref}/${branch}`, github);
        // レビュー担当が持つ「レビュー: …」のタスクは、消さずに取り消して離させる。消すと、持ったまま続きを呼んで落ち、後の通しの社員を塞ぐ
        const list: unknown = await (await page.request.get(`/api/v1/nodes?scope=${serviceId}&limit=100`)).json();
        const reviewId = findTaskId(list, `レビュー: #${String(issue)} 動画を作る`);
        if (reviewId !== null) await releaseReviewTask(page, reviewId);
        // 開発担当が持ったままのタスクを消すと、続きを呼んで落ち、後の通しの社員を塞ぐ。見送りにして離させ、離れてから消す
        await expect(() => releaseBuilderTask(page, ids.task)).toPass({ timeout: 10_000 });
        await expect
          .poll(async () => Held.parse(await (await page.request.get("/api/v1/staff")).json()).data.find((x) => x.id === "builder")?.nodeId ?? null, { timeout: 30_000 })
          .not.toBe(ids.task);
        seedMain(`DELETE FROM github_mirrors WHERE review_id IN (SELECT id FROM reviews WHERE node_id = '${ids.task}'); DELETE FROM reviews WHERE node_id = '${ids.task}'; DELETE FROM dev_issues WHERE id IN ('${ids.dev}', '${ids.parent}'); DELETE FROM notices WHERE kind = 'service_ready' AND scope = '${serviceId}'; DELETE FROM nodes WHERE id = '${ids.task}'`);
      } finally {
        // 後始末が落ちても勤務の時刻を戻す。外したタスクを開発担当に戻すのはその後 (外の finally)。逆だと、広げた勤務の間に開発担当が戻したタスクを取りうる
        await restoreSchedule?.();
      }
    }
  } finally {
    giveBackBuilderTasks(aside);
  }
});
