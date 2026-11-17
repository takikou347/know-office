// 開発の回し方の通しのうち、設計書を同じ時に直す所。開発担当が設計書の PR とコードの PR を出し、承認すると、設計書、コードの順に main に入り、Issue が閉じてタスクが済みになる。GitHub は開発の代わりの物を使う (開発の回し方の 3.6)
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { findTaskId, giveBackBuilderTasks, prototypeService, REPO, setAsideBuilderTasks } from "./helpers/dev-loop.ts";
import { restoreSeedServices, seedMain } from "./helpers/seed.ts";
import { clockInStaff, openTree, scriptReply } from "./helpers/staff-work.ts";

/** 通しの間だけ開発担当から外したタスクの ID。後始末で戻す */
const state = { aside: "" };

test.afterEach(() => {
  forgetGitHub();
  restoreSeedServices();
  giveBackBuilderTasks(state.aside);
  state.aside = "";
});

/** 代わりの GitHub への要求に付ける見出し */
const GITHUB = { headers: { authorization: "Bearer e2e", "user-agent": "know-office-e2e" } };
const Sha = z.object({ sha: z.string() });
const ref = (repo: string) => `${FAKE_GITHUB}/repos/${repo}/git/refs/heads`;
const body = (text: string) => ({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });

test("開発担当が設計書の PR とコードの PR を出し、オーナーが承認すると、設計書、コードの順に main に入り、Issue が閉じる", async ({ page }) => {
  test.slow();
  const { docs, serviceId } = await prototypeService(page, "設計書と入れる案");
  const origin = new URL(page.url()).origin;
  // 前の通しが残した読んでいない鍵と上限の通知は、どの社員の呼び出しも止めるので、先に読んだ事にする
  seedMain(`UPDATE notices SET read_at = ${String(Date.now())} WHERE kind IN ('sdk_auth_failed', 'claude_spend_limit') AND read_at IS NULL`);
  // 前の通しが開発担当に残したタスクは、先に取られて積んだ返事を使われるので、通しの間だけ開発担当から外す
  state.aside = await setAsideBuilderTasks(page);
  // 前の通しが落ちて消したタスクを持ったままの開発担当は、止めて再開して作り直させる
  const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: origin }, data: { scope: "staff", target: "builder", reason: "開発の回し方の通しの前に作り直す" } });
  expect(stopped.status()).toBe(201);
  await openTree(page);
  const ids = { task: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, dev: `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` };
  const commit = async (repo: string, parents: string[]): Promise<string> => {
    const res = await page.request.post(`${FAKE_GITHUB}/repos/${repo}/git/commits`, { ...GITHUB, data: { message: "m", tree: "1".repeat(40), parents } });
    if (!res.ok()) throw new Error(`コミットを置けない: ${String(res.status())} ${await res.text()}`);
    return Sha.parse(await res.json()).sha;
  };
  const put = async (repo: string, name: string, sha: string) => expect((await page.request.patch(`${ref(repo)}/${name}`, { ...GITHUB, data: { sha, force: true } })).status()).toBe(200);
  const mainOf = async (repo: string) => {
    const res = await page.request.get(`${FAKE_GITHUB}/repos/${repo}/git/ref/heads/main`, GITHUB);
    return res.ok() ? z.object({ object: Sha }).parse(await res.json()).object.sha : null;
  };

  // 代わりの GitHub に、サービスのリポジトリと設計書のリポジトリの main の先と、その上に出す前のブランチの先を置く。main は前の通しが進めているので、前の先を覚え、終わりに戻す
  const previous = { code: await mainOf(REPO), docs: await mainOf(docs) };
  const codeBase = await commit(REPO, []);
  const codeHead = await commit(REPO, [codeBase]);
  const docsBase = await commit(docs, []);
  const docsHead = await commit(docs, [docsBase]);
  const suffix = crypto.randomUUID().slice(0, 6);
  const codeName = `make${suffix}`;
  const docsName = `docs${suffix}`;
  const codeBranch = `ko/019a7b00-${codeName}`;
  const docsBranch = `ko/019a7b00-${docsName}`;
  const issue = z.object({ number: z.number() }).parse(await (await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/issues`, { ...GITHUB, data: { title: "動画を作る", body: "設計書: 詳細設計 1-video の要件「動画を作る」", labels: ["feature"] } })).json()).number;

  // 設計書の PR が変えるのは概要だけ。木、中身、変えたファイル、チェックを置く
  const dir = "services/know-office";
  const readme = ["---", "name: know-office", "summary: 管理室", `repo: ${REPO}`, "kind: tool", "status: planning", "visibility: public", "---", "", "# know-office"].join("\n");
  await fakeGitHubRoute(page, `GET /repos/${docs}`, { full_name: docs, private: true, default_branch: "main" });
  await fakeGitHubRoute(page, `GET /repos/${docs}/git/trees/${docsHead}`, { sha: docsHead, tree: [`${dir}/README.md`, `${dir}/docs/01-overview/index.md`].map((path) => ({ path, mode: "100644", type: "blob", sha: "1".repeat(40) })), truncated: false });
  await fakeGitHubRoute(page, `GET /repos/${docs}/contents/${dir}/README.md`, body(readme));
  await fakeGitHubRoute(page, `GET /repos/${docs}/contents/${dir}/docs/01-overview/index.md`, body("# 概要\n"));
  await fakeGitHubRoute(page, `GET /repos/${docs}/compare/main...${docsHead}`, { status: "ahead", files: [{ filename: `${dir}/docs/01-overview/index.md`, status: "modified" }] });
  for (const [repo, sha] of [[docs, docsHead], [REPO, codeHead]] as const) {
    await fakeGitHubRoute(page, `GET /repos/${repo}/commits/${sha}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  }

  // 試作に進めた時の「設計書を書くタスク」は、設計書が入った後の姿にするため見送る。残っていると、同じサービスの設計書を直すタスクとして重なる
  seedMain(`UPDATE nodes SET status = 'dropped' WHERE source = 'design:${serviceId}'`);
  // 子 Issue のタスクと行は、設計書から Issue を立てる道 (社長の issue_plan) の結果なので、手元の D1 に置く
  const now = String(Date.now());
  const mark = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  seedMain(
    `INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, repo, issue_number, source, assignee, task_kind, version, created_by, created_at, updated_at) VALUES ('${ids.task}', 'task', '019a7b00-0000-7000-8000-0000000000e3', '${serviceId}', '#${String(issue)} 動画を作る', 'todo', 0, '${REPO}', ${String(issue)}, 'issue:${String(issue)}', NULL, 'build', 1, 'system', ${now}, ${now})`,
  );
  seedMain(
    `INSERT INTO dev_issues (id, service_id, repo, number, issue_id, kind, feature, requirement, req_hash, issue_kind, paths, heads, mark_key, state, created_at) VALUES ('${ids.dev}', '${serviceId}', '${REPO}', ${String(issue)}, ${String(issue)}, 'child', '1-video', '動画を作る', 'e2e', 'feature', '["src/a.ts"]', '["src/a.ts"]', '${mark}', 'open', ${now})`,
  );

  let restoreSchedule: (() => Promise<void>) | null = null;
  try {
    restoreSchedule = await clockInStaff(page, "builder");
    await put(REPO, "main", codeBase);
    await put(REPO, codeBranch, codeHead);
    await put(docs, "main", docsBase);
    await put(docs, docsBranch, docsHead);
    // GitHub は Issue と PR でリポジトリごとの 1 つの番号を使う。設計書のリポジトリで次に出る PR の番号は、今の Issue と PR の番号の最大 + 1
    const used = z.array(z.object({ number: z.number() })).parse(await (await page.request.get(`${FAKE_GITHUB}/repos/${docs}/issues?state=all&per_page=100`, GITHUB)).json());
    const docsPr = Math.max(0, ...used.map((i) => i.number)) + 1;
    // 代わりの Claude が、開発担当に docs_pr_open、続けて docsPr を結んだ pr_open を呼ばせて終える
    await scriptReply(page, [{ type: "tool_use", id: "toolu_flow_docs_pr_open", name: "mcp__staff__docs_pr_open", input: { name: docsName, title: "概要を直す", body: "仕様が変わった" } }], "tool_use", undefined, "builder");
    await scriptReply(page, [{ type: "tool_use", id: "toolu_flow_pr_open", name: "mcp__staff__pr_open", input: { name: codeName, title: "動画を作る", body: "動画を作った", docsPr } }], "tool_use", undefined, "builder");
    await scriptReply(page, [{ type: "text", text: "PR を出した" }], "end_turn", undefined, "builder");
    expect((await page.request.patch(`/api/v1/nodes/${ids.task}`, { headers: { Origin: origin }, data: { version: 1, assignee: "builder" } })).status()).toBe(200);

    const detail = async () => z.object({ data: z.object({ status: z.string(), events: z.array(z.object({ kind: z.string(), detail: z.record(z.string(), z.unknown()) }).loose()) }).loose() }).parse(await (await page.request.get(`/api/v1/nodes/${ids.task}`)).json()).data;
    await expect.poll(async () => ["todo", "doing"].includes((await detail()).status), { timeout: 60_000 }).toBe(false);
    const events = (await detail()).events;
    expect((await detail()).status, events.map((e) => `${e.kind} ${JSON.stringify(e.detail)}`).join(" | ")).toBe("review");
    expect(events.find((e) => e.kind === "docs_pr_opened")?.detail["prNumber"]).toBe(docsPr);
    expect(events.find((e) => e.kind === "pr_opened")?.detail["docsPr"]).toBe(docsPr);

    // レビュー担当の承認は社員のツールなので手元の D1 に置く。オーナーが承認すると、2 つの条件がそろっているので、設計書、コードの順に main が進み、Issue が閉じる
    seedMain(`UPDATE reviews SET reviewer_verdict = 'approve', reviewer_summary = '確かめた' WHERE node_id = '${ids.task}'`);
    const verdict = await page.request.post(`/api/v1/reviews/${ids.task}/verdict`, { data: { verdict: "approve", body: "よい", baseSha: codeHead }, headers: { Origin: origin } });
    const sent = z.array(z.object({ route: z.string() }).loose()).parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json());
    expect(verdict.status(), `${await verdict.text()} ${sent.slice(-8).map((r) => r.route).join(" | ")}`).toBe(200);
    await expect
      .poll(async () => z.object({ state: z.string(), state_reason: z.string().nullable() }).parse(await (await page.request.get(`${FAKE_GITHUB}/repos/${REPO}/issues/${String(issue)}`, GITHUB)).json()), { timeout: 20_000 })
      .toEqual({ state: "closed", state_reason: "completed" });
    expect((await detail()).status).toBe("done");
    expect(await mainOf(docs)).toBe(docsHead);
    expect(await mainOf(REPO)).toBe(codeHead);
    // 設計書の main の更新が、コードの main の更新より先
    const moves = z.array(z.object({ route: z.string() }).loose()).parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json()).map((r) => r.route);
    const at = (repo: string) => moves.findLastIndex((r) => r.startsWith("PATCH") && r.endsWith(`/repos/${repo}/git/refs/heads/main`));
    expect(at(docs)).toBeGreaterThan(-1);
    expect(at(docs)).toBeLessThan(at(REPO));
    // 画面のタスクが済みになっている
    await page.goto("/staff/builder?tab=tasks");
    const row = page.getByRole("main").locator("li", { hasText: `#${String(issue)} 動画を作る` }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("済", { exact: true })).toBeVisible();
  } finally {
    // 後の通しに残さない。main は前の先に戻し (前が無ければ消し)、出したブランチも消す
    for (const [repo, was, names] of [[REPO, previous.code, [codeBranch]], [docs, previous.docs, [docsBranch]]] as const) {
      if (was === null) await page.request.delete(`${ref(repo)}/main`, GITHUB);
      else await page.request.patch(`${ref(repo)}/main`, { ...GITHUB, data: { sha: was, force: true } });
      for (const name of names) await page.request.delete(`${ref(repo)}/${name}`, GITHUB);
    }
    const list: unknown = await (await page.request.get(`/api/v1/nodes?scope=${serviceId}&limit=100`)).json();
    const reviewId = findTaskId(list, `レビュー: #${String(issue)} 動画を作る`);
    if (reviewId !== null) {
      const version = z.object({ data: z.object({ version: z.number() }).loose() }).parse(await (await page.request.get(`/api/v1/nodes/${reviewId}`)).json()).data.version;
      await page.request.patch(`/api/v1/nodes/${reviewId}`, { headers: { Origin: origin }, data: { version, status: "dropped" } });
    }
    try {
      seedMain(`DELETE FROM github_mirrors WHERE review_id IN (SELECT id FROM reviews WHERE node_id = '${ids.task}'); DELETE FROM reviews WHERE node_id = '${ids.task}'; DELETE FROM task_docs WHERE node_id = '${ids.task}'; DELETE FROM dev_issues WHERE id = '${ids.dev}'; DELETE FROM nodes WHERE id = '${ids.task}'`);
    } finally {
      // 後始末が落ちても勤務の時刻を戻す。外したタスクを開発担当に戻すのはその後 (afterEach)
      await restoreSchedule?.();
    }
  }
});
