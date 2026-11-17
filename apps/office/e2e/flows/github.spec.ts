// GitHub 連携の通し。オーナーが設定の画面のボタンで App を作って入れ、連携したリポジトリを読み、ルールセットを掛け直す。全体を止めた後は鍵を入れ直して再開する。GitHub のレート制限は上部の帯の通知に出る。ゲートウェイの返事は差し替えず、GitHub は開発の代わりの物に記録した返事を置く (タスクとレビューの 3.2 と 3.4、サービスと拡張の 3.5)
import type { Locator, Page, Request } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";
import { createClaudeKey, FAKES } from "../helpers/fakes.ts";

/** 開発の代わりの GitHub。.dev.vars の DEV_FAKES_URL */
const FAKE_GITHUB = `${FAKES}/github`;

/** GitHub のレート制限の通知の題 (サービスと拡張の 3.5) */
const RATE_TITLE = "GitHub の API のレート制限に届いた";

/** 代わりの GitHub がインストールで選ぶリポジトリ */
const REPOS = ["example/knowidea-ui", "example/know-office"];

/** 最初に登録したサービスと、そのリポジトリ */
const SERVICES = [
  { id: "00000000-0000-7000-8000-000000000101", repo: "takikou347/knowidea-ui", linked: "example/knowidea-ui" },
  { id: "00000000-0000-7000-8000-000000000102", repo: "takikou347/know-office", linked: "example/know-office" },
];

/**
 * 連携を切った今に戻す。vault の GitHub の行を取り消し、サービスのリポジトリを最初の値に戻す。代わりの GitHub の App は開発の入口を止めると消える
 */
function unlink(): void {
  seedMain(`UPDATE vault SET revoked_at = ${String(Date.now())} WHERE name IN ('github_app', 'github_installation') AND revoked_at IS NULL`);
  for (const s of SERVICES) seedMain(`UPDATE services SET repo = '${s.repo}' WHERE id = '${s.id}'`);
}

/**
 * 連携したリポジトリを読む要求かを返す
 * @param r 画面が送った要求
 * @returns リポジトリを読む要求なら true
 */
function isRepos(r: Request): boolean {
  return new URL(r.url()).pathname === "/api/v1/github/repos";
}

/**
 * 設定の画面の GitHub のカードを探す
 * @param page 開いているページ
 * @returns カード
 */
function githubCard(page: Page): Locator {
  return page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 2, name: "GitHub", exact: true }) });
}

/**
 * 代わりの GitHub に、リポジトリの記録した返事を置く。公開で、ルールセットはまだ無い
 * @param page 開いているページ
 * @param repo リポジトリ
 */
async function recordRepo(page: Page, repo: string): Promise<void> {
  // 代わりの GitHub は /github の下に立つので、置く道もその下の道にする
  const replies: [string, unknown][] = [
    [`GET /github/repos/${repo}`, { full_name: repo, private: false, default_branch: "main" }],
    [`GET /github/repos/${repo}/commits/main/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] }],
    [`GET /github/repos/${repo}/rulesets`, []],
    [`POST /github/repos/${repo}/rulesets`, { id: 7, name: "know-office" }],
  ];
  for (const [route, body] of replies) {
    const res = await page.request.post(`${FAKE_GITHUB}/__fake/routes`, { data: { route, body } });
    expect(res.status()).toBe(204);
  }
}

const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), stopId: z.string() })) }) });

/**
 * 前の通しが全体を止めたまま落ちた時に、鍵を入れ直して再開する。画面の確かめでなく片付けなので、パスキーの確認は D1 に直に置く
 * @param page 開いているページ。画面を 1 度開いてログインセッションを持っている事
 * @param slug 代わりの GitHub の App の名前。連携していなければ null
 */
async function resumeOffice(page: Page, slug: string | null): Promise<void> {
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  const office = state.data.stopped.find((s) => s.scope === "office");
  if (!office) return;
  seedMain(`UPDATE sessions SET step_up_until = ${String(Date.now() + 10 * 60_000)} WHERE ended_at IS NULL`);
  const headers = { Origin: new URL(page.url()).origin };
  const apiKey = `sk-ant-cleanup-${crypto.randomUUID()}`;
  await createClaudeKey(page.request, apiKey);
  await page.request.put("/api/v1/guard/keys/claude", { headers, data: { apiKey } });
  if (slug !== null) {
    const pem = await (await page.request.post(`${FAKE_GITHUB}/web/settings/apps/${slug}/keys`)).text();
    await page.request.put("/api/v1/guard/keys/github-app", { headers, data: { privateKey: pem, webhookSecret: "cleanup-webhook-secret" } });
  }
  expect((await page.request.post(`/api/v1/guard/stops/${office.stopId}/resume`, { headers })).status()).toBe(200);
}

/**
 * 設定の画面の連携するボタンで連携する。App を作る画面とインストールの画面は代わりの GitHub がそのまま進める
 * @param page 開いているページ
 * @returns 代わりの GitHub が作った App の名前
 */
async function linkFromScreen(page: Page): Promise<string> {
  let slug: string | null = null;
  // 開発の画面はリポジトリを 2 度読み、連携済みと出た時にまだ読んでいる事がある。読み終える前に失敗を置くと、残った読みが失敗を使い切る
  let reading = 0;
  const done = (r: Request) => {
    if (isRepos(r)) reading--;
  };
  page.on("request", (r) => {
    slug ??= /\/web\/apps\/([^/]+)\/installations\/new/.exec(r.url())?.[1] ?? null;
    if (isRepos(r)) reading++;
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  await page.goto("/settings");
  await expect(githubCard(page).getByText("連携していない")).toBeVisible();
  await githubCard(page).getByRole("button", { name: "連携する" }).click();
  await page.waitForURL("**/settings");
  await expect(githubCard(page).getByText("連携済み")).toBeVisible();
  await expect(githubCard(page).getByRole("list", { name: "連携したリポジトリ" })).toBeVisible();
  await expect.poll(() => reading).toBe(0);
  expect(slug).not.toBeNull();
  return slug ?? "";
}

/**
 * 読んでいない GitHub のレート制限の通知を読む。残すと次の通しの帯に出る
 * @param page 画面を開いたページ
 */
async function readRateNotices(page: Page): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  const notices = z.object({ data: z.array(z.object({ id: z.string(), title: z.string(), readAt: z.string().nullable() }).loose()) }).parse(await (await page.request.get("/api/v1/notices?limit=100")).json());
  for (const n of notices.data.filter((x) => x.title === RATE_TITLE && x.readAt === null)) expect((await page.request.put(`/api/v1/notices/${n.id}/read`, { headers })).status()).toBe(204);
}

/**
 * 上部の帯に GitHub のレート制限の通知が出るまで待つ。帯は未読を 1 件ずつ出すので、先に出たほかの通知は帯で読んで送る
 * @param page 画面を開いたページ
 * @returns レート制限の通知の帯
 */
async function rateBar(page: Page): Promise<Locator> {
  const bar = page.getByRole("status").filter({ hasText: RATE_TITLE });
  const top = page.getByRole("alert").or(page.getByRole("status")).filter({ has: page.getByRole("button", { name: "読んだ" }) });
  await expect
    .poll(
      async () => {
        if (await bar.isVisible()) return true;
        if (await top.first().isVisible()) await top.first().getByRole("button", { name: "読んだ" }).click();
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return bar;
}

let linked: string | null = null;

test.beforeEach(() => {
  linked = null;
  unlink();
});

test.afterEach(async ({ page }) => {
  await resumeOffice(page, linked);
  unlink();
  expect((await page.request.delete(`${FAKE_GITHUB}/__fake/failures`)).status()).toBe(204);
});

test.describe("ボタン 1 つで連携する", () => {
  test("連携するを押し、パスキーで確かめると、App を作って入れ、連携したリポジトリが出る", async ({ page }) => {
    await useOwnerPasskey(page);
    linked = await linkFromScreen(page);
    const repos = githubCard(page).getByRole("list", { name: "連携したリポジトリ" });
    for (const repo of REPOS) await expect(repos.getByText(repo)).toBeVisible();
    await expect(githubCard(page).getByRole("button", { name: "連携する" })).toHaveCount(0);
  });

  test("連携していても GitHub がリポジトリを返さなければ、読めなかった事を出す", async ({ page }) => {
    await useOwnerPasskey(page);
    linked = await linkFromScreen(page);
    const res = await page.request.post(`${FAKE_GITHUB}/__fake/failures`, { data: { route: "GET /installation/repositories", status: 500, times: 4 } });
    expect(res.status()).toBe(204);
    await page.reload();
    await expect(githubCard(page).getByText("連携済み")).toBeVisible();
    await expect(githubCard(page).getByText("連携したリポジトリを読めませんでした")).toBeVisible();
    await expect(githubCard(page).getByText("理由: upstream_failed")).toBeVisible();
  });
});

test.describe("落ちても続きから", () => {
  test("GitHub のレート制限に届く", async ({ page }) => {
    await useOwnerPasskey(page);
    linked = await linkFromScreen(page);
    await readRateNotices(page);
    // 開発の画面は読み込みを 2 度走らせるので、2 度ともレート制限で断る
    const res = await page.request.post(`${FAKE_GITHUB}/__fake/failures`, { data: { route: "GET /installation/repositories", status: 403, times: 4, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } } });
    expect(res.status()).toBe(204);
    try {
      await page.reload();
      const bar = await rateBar(page);
      await expect(bar.getByText("60 秒後から送り直せる")).toBeVisible();
      await bar.getByRole("button", { name: "読んだ" }).click();
      await expect(bar).toHaveCount(0);
    } finally {
      await readRateNotices(page);
    }
  });
});

test.describe("ブランチの保護をルールから掛ける", () => {
  test("掛け直す", async ({ page }) => {
    await useOwnerPasskey(page);
    linked = await linkFromScreen(page);
    // 最初のサービスのリポジトリを、代わりの GitHub に入れたリポジトリに向ける
    for (const s of SERVICES) seedMain(`UPDATE services SET repo = '${s.linked}' WHERE id = '${s.id}'`);
    for (const repo of REPOS) await recordRepo(page, repo);
    await githubCard(page).getByRole("button", { name: "ルールセットを掛け直す" }).click();
    await expect(githubCard(page).getByText(`${REPOS.join("、")} に掛けました`)).toBeVisible();
  });
});

test.describe("全体を止める", () => {
  test("全体を止めると、鍵を入れ直すまで再開できず、GitHub App と Claude の鍵を入れ直すと再開できる", async ({ page }) => {
    await useOwnerPasskey(page);
    linked = await linkFromScreen(page);

    await page.goto("/guard");
    await page.getByRole("main").getByRole("button", { name: "すべての社員を止める" }).click();
    await page.getByRole("dialog", { name: "全体を止めますか" }).getByRole("button", { name: "止める", exact: true }).click();
    await expect(page.getByRole("main").getByText("全体を止めました")).toBeVisible();
    await page.getByRole("main").getByRole("button", { name: "すべての社員を再開する" }).click();
    await expect(page.getByRole("main").getByText("全体を再開する前に、設定の画面で GitHub App と Claude の鍵を入れ直してください")).toBeVisible();

    await page.goto("/settings");
    const main = page.getByRole("main");
    // GitHub の App の設定で新しい秘密鍵を作る。代わりの GitHub は PEM を返す
    const pem = await (await page.request.post(`${FAKE_GITHUB}/web/settings/apps/${linked}/keys`)).text();
    await main.getByLabel("新しい秘密鍵 (PEM)").fill(pem);
    await main.getByLabel("新しい Webhook secret").fill("e2e-webhook-secret-0001");
    await main.getByRole("button", { name: "GitHub App の鍵を入れる" }).click();
    // Anthropic の画面で鍵を作り直してから入れる
    const apiKey = `sk-ant-e2e-${crypto.randomUUID()}`;
    await createClaudeKey(page.request, apiKey);
    await main.getByLabel("新しい API の鍵").fill(apiKey);
    await main.getByRole("button", { name: "Claude の鍵を入れる" }).click();
    // 手順の文にも「入れ直した」があるので、印の言葉だけをちょうどで数える
    await expect(main.getByText("入れ直した", { exact: true })).toHaveCount(2);

    await page.goto("/guard");
    await page.getByRole("main").getByRole("button", { name: "すべての社員を再開する" }).click();
    await expect(page.getByRole("main").getByText(/すべての社員を .+ に再開しました/)).toBeVisible();
    await expect(page.getByRole("main").getByText("止めている物は無い")).toBeVisible();
  });
});
