// 開発の回し方の通し。オーナーが設定の画面で設計書のリポジトリを選び、案を試作に進めると、社員とタスクの画面に開発担当の「設計書: <名前>」のタスクが出る。設計書が main で変わる通知が届くと、社長の「Issue を合わせる: <名前>」のタスクが出る。ゲートウェイの返事は差し替えず、GitHub は開発の代わりの物を使う (開発の回し方の 3.1、3.2、3.3)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { openTree, scriptReply } from "./helpers/staff-work.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { freeRepoNames, restoreSeedServices, seedMain } from "./helpers/seed.ts";
import { addIdea, choose, chooseDocsRepo, move } from "./helpers/services.ts";

/** 代わりの GitHub がインストールで選ぶ、サービスのリポジトリ */
const REPO = "example/know-office";

/**
 * 木の返事から、題が合うタスクの ID を探す
 * @param tree 木の返事
 * @param title 探す題
 * @returns タスク ID。無ければ null
 */
function findTaskId(tree: unknown, title: string): string | null {
  const pending: unknown[] = [tree];
  const Item = z.object({ id: z.string().optional(), title: z.string().optional() }).loose();
  while (pending.length > 0) {
    const node = pending.pop();
    const list = z.array(z.unknown()).safeParse(node);
    if (list.success) {
      pending.push(...list.data);
      continue;
    }
    const item = Item.safeParse(node);
    if (!item.success) continue;
    if (item.data.title === title && item.data.id !== undefined) return item.data.id;
    pending.push(...Object.values(item.data));
  }
  return null;
}

/**
 * 設計書のリポジトリを選び、案を足して試作に進める。サービスのリポジトリは REPO
 * @param page 開いているページ
 * @param label 案の名前の頭
 * @returns 設計書のリポジトリ、案の名前、サービス ID
 */
async function prototypeService(page: Page, label = "Issue の案"): Promise<{ docs: string; title: string; serviceId: string }> {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  const docs = await chooseDocsRepo(page);

  const title = `${label} ${crypto.randomUUID().slice(0, 8)}`;
  const serviceId = await addIdea(page, title);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる価値がある");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();
  return { docs, title, serviceId };
}

test.afterEach(() => {
  forgetGitHub();
  restoreSeedServices();
});

test("設計書のリポジトリを選んで試作に進める", async ({ page }) => {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  await chooseDocsRepo(page);

  const title = `設計書の案 ${crypto.randomUUID().slice(0, 8)}`;
  await addIdea(page, title);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる価値がある");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  // サービスのリポジトリは、非公開の設計書のリポジトリとは別の物から選ぶ
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();

  // 開発担当に、設計書のリポジトリへ書くタスクが足されている
  await page.goto("/staff/builder?tab=tasks");
  await expect(page.getByRole("main").getByText(`設計書: ${title}`).first()).toBeVisible();
});

test("設計書が main で変わる通知から、社長の Issue を合わせるタスクが画面に出る", async ({ page }) => {
  const { docs, title, serviceId } = await prototypeService(page);

  // 設計書のリポジトリの main に、サービスの詳細設計の機能のファイルが入った事にする。通知の先で読む木と中身を、代わりの GitHub に置く
  // 同じ本文の通知は 2 度目として捨てられるので、通しごとに違う先にする
  const sha = `${crypto.randomUUID().replaceAll("-", "")}00000000`.slice(0, 40);
  const file = "services/know-office/docs/04-detail/1-video.md";
  const text = ["# 詳細設計 1. 動画", "", "## 1. 要件", "", "- **動画を作る**: 文章から作る", ""].join("\n");
  await fakeGitHubRoute(page, `GET /repos/${docs}/git/trees/${sha}`, { sha, tree: [{ path: file, mode: "100644", type: "blob", sha: "1".repeat(40) }], truncated: false });
  await fakeGitHubRoute(page, `GET /repos/${docs}/contents/${file}`, { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });
  // 代わりの GitHub が、App の通知の宛先へ署名して push の通知を送る
  const pushed = await page.request.post(`${FAKE_GITHUB}/__fake/hooks`, {
    data: { event: "push", payload: { ref: "refs/heads/main", after: sha, repository: { full_name: docs, default_branch: "main" }, commits: [{ modified: [file] }] } },
  });
  expect(pushed.status()).toBe(204);

  // 社長のタスクに、Issue を合わせるタスクが出る。社長の山は先頭の 100 件までなので、ほかの通しが積んだ後でも開けるよう、サービスの範囲から探したタスクの詳細を開く
  const found: { id: string | null } = { id: null };
  await expect
    .poll(async () => {
      found.id = findTaskId(await (await page.request.get(`/api/v1/nodes?scope=${serviceId}&limit=100`)).json(), `Issue を合わせる: ${title}`);
      return found.id !== null;
    }, { timeout: 20_000 })
    .toBe(true);
  const taskId = found.id ?? "";
  await page.goto(`/staff/president/tasks/${taskId}`);
  await expect(page.getByRole("main").getByRole("heading", { level: 2, name: `Issue を合わせる: ${title}` })).toBeVisible();
});

test("開発担当が子 Issue の PR を出し、オーナーが承認して main に入ると、GitHub の Issue が閉じ、タスクが済みになる", async ({ page }) => {
  test.slow();
  const { serviceId } = await prototypeService(page, "入れる案");
  // 前の通しが残した読んでいない鍵と上限の通知は、どの社員の呼び出しも止めるので、先に読んだ事にする
  seedMain(`UPDATE notices SET read_at = ${String(Date.now())} WHERE kind IN ('sdk_auth_failed', 'claude_spend_limit') AND read_at IS NULL`);
  // 前の通しが落ちて消したタスクを持ったままの開発担当は、止めて再開して作り直させる
  const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "staff", target: "builder", reason: "開発の回し方の通しの前に作り直す" } });
  expect(stopped.status()).toBe(201);
  // 子 Issue のタスクの親にする、通しの木 (開発担当の作業の開始が祖先の木を読む)。止めた社員もここで再開する
  await openTree(page);
  const ids = { task: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, dev: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` };
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
  await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${head}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });

  // 子 Issue のタスクと行は、設計書から Issue を立てる道 (社長の issue_plan) の結果なので、手元の D1 に置く。PR は置かず、開発担当に出させる
  const now = String(Date.now());
  const mark = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  seedMain(
    `INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, repo, issue_number, source, assignee, task_kind, version, created_by, created_at, updated_at) VALUES ('${ids.task}', 'task', '019a7b00-0000-7000-8000-0000000000e3', '${serviceId}', '#${String(issue)} 動画を作る', 'todo', 0, '${REPO}', ${String(issue)}, 'issue:${String(issue)}', NULL, 'build', 1, 'system', ${now}, ${now})`,
  );
  seedMain(
    `INSERT INTO dev_issues (id, service_id, repo, number, issue_id, kind, feature, requirement, req_hash, issue_kind, paths, heads, mark_key, state, created_at) VALUES ('${ids.dev}', '${serviceId}', '${REPO}', ${String(issue)}, ${String(issue)}, 'child', '1-video', '動画を作る', 'e2e', 'feature', '["src/a.ts"]', '["src/a.ts"]', '${mark}', 'open', ${now})`,
  );

  try {
    await put("main", base);
    await put(branch, head);
    // 代わりの Claude が、開発担当に pr_open を呼ばせて終える。ブランチ名は ko/<タスク ID の頭 8 字>-<name>
    const name = branch.slice("ko/019a7b00-".length);
    await scriptReply(page, [{ type: "tool_use", id: "toolu_flow_pr_open", name: "mcp__staff__pr_open", input: { name, title: "動画を作る", body: "動画を作った" } }], "tool_use", undefined, "builder");
    await scriptReply(page, [{ type: "text", text: "PR を出した" }], "end_turn", undefined, "builder");
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
    // 画面のタスクが済みになっている
    await page.goto("/staff/builder?tab=tasks");
    const row = page.getByRole("main").locator("li", { hasText: `#${String(issue)} 動画を作る` }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("済", { exact: true })).toBeVisible();
  } finally {
    // 後の通しに残さない。main は前の先に戻し (前が無ければ消し)、出したブランチも消す
    if (previous === null) await page.request.delete(`${ref}/main`, github);
    else await page.request.patch(`${ref}/main`, { ...github, data: { sha: previous, force: true } });
    await page.request.delete(`${ref}/${branch}`, github);
    // レビュー担当が持つ「レビュー: …」のタスクは、消さずに取り消して離させる。消すと、持ったまま続きを呼んで落ち、後の通しの社員を塞ぐ
    const list: unknown = await (await page.request.get(`/api/v1/nodes?scope=${serviceId}&limit=100`)).json();
    const reviewId = findTaskId(list, `レビュー: #${String(issue)} 動画を作る`);
    if (reviewId !== null) {
      const version = z.object({ data: z.object({ version: z.number() }).loose() }).parse(await (await page.request.get(`/api/v1/nodes/${reviewId}`)).json()).data.version;
      await page.request.patch(`/api/v1/nodes/${reviewId}`, { headers: { Origin: new URL(page.url()).origin }, data: { version, status: "dropped" } });
    }
    // 済みの子のタスクは、開発担当が離れているので消してよい。ミラーとレビューも消す
    seedMain(`DELETE FROM github_mirrors WHERE review_id IN (SELECT id FROM reviews WHERE node_id = '${ids.task}'); DELETE FROM reviews WHERE node_id = '${ids.task}'; DELETE FROM dev_issues WHERE id = '${ids.dev}'; DELETE FROM nodes WHERE id = '${ids.task}'`);
  }
});
