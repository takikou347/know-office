// アイデアとサービスの画面の通し。オーナーが画面で案を足し、検討して元の案をたどり、リポジトリを選んで作ると決め、設定でリポジトリを変え、前のバージョンに戻す。サービスで本番にデプロイする時も、main に push が入った時も、デプロイの条件が足りなければ走らせない。見送る案も画面で見送る。デプロイの条件が足りなければサービスにできず、そろえるとサービスに進む。
// 画面から作れない検討の材料 (社長が出す) とデプロイの記録 (GitHub の通知が作る) だけを手元の D1 と R2 に置き、ゲートウェイの返事は差し替えない (サービスと拡張の 3.1 から 3.3)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { freeRepoNames, restoreSeedServices, runLocalWrangler, seedMain } from "./helpers/seed.ts";
import { addIdea, choose, chooseDocsRepo, move, prototypeService, settingCard } from "./helpers/services.ts";

/** 代わりの GitHub がインストールで選ぶリポジトリ */
const REPO = "example/know-office";
const OTHER_REPO = "example/knowidea-ui";

/**
 * workflow を動かす要求の道。代わりの GitHub は /github の下に立つ
 * @param workflow workflow のファイル
 * @returns 道
 */
const dispatchRoute = (workflow: string) => `POST /github/repos/${REPO}/actions/workflows/${workflow}/dispatches`;

const Requests = z.array(z.object({ route: z.string(), body: z.unknown() }).loose());

/**
 * 代わりの GitHub が受けた、workflow を動かす要求の本文
 * @param page 開いているページ
 * @param workflow workflow のファイル
 * @returns 本文の並び
 */
async function dispatchBodies(page: Page, workflow: string): Promise<unknown[]> {
  const all = Requests.parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json());
  return all.filter((r) => r.route === dispatchRoute(workflow)).map((r) => r.body);
}

/**
 * 代わりの GitHub が受けた、戻す workflow を動かす要求の数
 * @param page 開いているページ
 * @returns 数
 */
async function dispatches(page: Page): Promise<number> {
  return (await dispatchBodies(page, "rollback.yml")).length;
}

/** 本番にデプロイする通しが使う、既定のブランチの先 */
const DEPLOY_HEAD = "e".repeat(40);

/**
 * 代わりの GitHub に、サービスのリポジトリの main へ push した通知を送らせる。本文は送るたびに変え、同じ本文の重ねた通知と見なされないようにする
 * @param page 開いているページ
 */
async function pushMain(page: Page): Promise<void> {
  const before = crypto.randomUUID().replaceAll("-", "").padEnd(40, "0");
  const res = await page.request.post(`${FAKE_GITHUB}/__fake/hooks`, {
    data: { event: "push", payload: { ref: "refs/heads/main", before, after: DEPLOY_HEAD, commits: [], repository: { full_name: REPO, default_branch: "main" } } },
  });
  expect(res.status()).toBe(204);
}

/**
 * 画面で案を足してサービスまで進め、設定の画面で本番にデプロイする条件を変える。既定のブランチの先は、チェックが終わらずレビュー担当の承認も無い所に置く
 * @param page 開いているページ
 * @param owner 条件にオーナーの承認を残すか
 * @returns その前に代わりの GitHub が受けた、deploy.yml を動かす要求の数
 */
async function deployableService(page: Page, owner: boolean): Promise<number> {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  await chooseDocsRepo(page);
  await addIdea(page, `デプロイする案 ${crypto.randomUUID().slice(0, 8)}`);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();
  // 初期値 (オーナーの承認だけ) のうちにサービスに進める
  await move(page, "サービスにする", "本番に出す");
  await expect(main.getByRole("button", { name: "サービスにする" })).toHaveCount(0);
  // 設定の画面で、本番にデプロイする条件にチェックとレビュー担当の承認を足す
  await main.getByRole("tab", { name: "設定" }).click();
  const deployWhen = main.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "本番にデプロイする条件", exact: true }) });
  if (!owner) await deployWhen.getByRole("checkbox", { name: "オーナーの承認" }).uncheck();
  await deployWhen.getByRole("checkbox", { name: "チェックの合格" }).check();
  await deployWhen.getByRole("checkbox", { name: "レビュー担当の承認" }).check();
  await deployWhen.getByLabel("本番にデプロイする条件を変える理由").fill("チェックとレビューも見る");
  await deployWhen.getByRole("button", { name: "本番にデプロイする条件を変える" }).click();
  await expect(deployWhen.getByText(/本番にデプロイする条件を変えました/)).toBeVisible();

  // 既定のブランチの先のチェックはまだ終わらず、レビュー担当の承認も無い
  await fakeGitHubRoute(page, `GET /repos/${REPO}`, { full_name: REPO, private: false, default_branch: "main" });
  await fakeGitHubRoute(page, `GET /repos/${REPO}/git/ref/heads/main`, { ref: "refs/heads/main", object: { sha: DEPLOY_HEAD } });
  await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${DEPLOY_HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "in_progress", conclusion: null }] });
  await fakeGitHubRoute(page, `POST /repos/${REPO}/actions/workflows/deploy.yml/dispatches`, {});
  return (await dispatchBodies(page, "deploy.yml")).length;
}

/**
 * 既定のブランチの先のチェックを通し、レビュー担当がそのコミットを承認した所を置く。社員の承認は画面から作れないので手元の D1 に置く
 * @param page 開いているページ
 */
async function meetDeployWhen(page: Page): Promise<void> {
  await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${DEPLOY_HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  seedMain(
    `INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, checks, reviewer_verdict) VALUES ('${crypto.randomUUID()}', '${crypto.randomUUID()}', '${REPO}', 1, 'x', '${"a".repeat(40)}', '${DEPLOY_HEAD}', '[]', 'approve')`,
  );
}

/**
 * 社長が出したのと同じ検討の材料を、手元の R2 に置いて案から指す
 * @param serviceId サービス ID
 * @param body 材料
 */
function seedStudy(serviceId: string, body: string): void {
  const key = `studies/${serviceId}/${crypto.randomUUID()}.md`;
  const file = join(mkdtempSync(join(tmpdir(), "study-")), "study.md");
  writeFileSync(file, body);
  runLocalWrangler(["exec", "wrangler", "r2", "object", "put", `know-office-files/${key}`, "--local", `--file=${file}`]);
  seedMain(`UPDATE services SET study_key = '${key}' WHERE id = '${serviceId}'`);
}

test.afterEach(() => {
  // デプロイの条件の通しが置いた、レビュー担当の承認の行
  seedMain(`DELETE FROM reviews WHERE head_sha IN ('${"d".repeat(40)}', '${DEPLOY_HEAD}')`);
  // 本番にデプロイする通しが取った錠
  seedMain("DELETE FROM locks WHERE name LIKE 'service.deploy:%'");
  forgetGitHub();
  restoreSeedServices();
});

test("案を足し、検討して元の案をたどり、リポジトリを選んで作り、設定を変えて前のバージョンに戻す", async ({ page }) => {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  // 試作に進める前に、設計書のリポジトリを設定で選ぶ
  await chooseDocsRepo(page);
  const before = await dispatches(page);
  const title = `通しの案 ${crypto.randomUUID().slice(0, 8)}`;
  const id = await addIdea(page, title);
  const main = page.getByRole("main");

  await move(page, "検討に進める", "調べる価値がある");
  // 検討の段階では、次に移せる先が作ると決める事になる
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  seedStudy(id, "市場は小さいが、手元の作業が減る");
  await page.reload();
  await main.getByRole("tab", { name: "元の案" }).click();
  await expect(main.getByText("市場は小さいが、手元の作業が減る")).toBeVisible();
  await expect(main.getByText("通しで確かめる案")).toBeVisible();
  await expect(main.getByText("0.00 ドル")).toHaveCount(2);

  // 作ると決める時は、代わりの GitHub の触れるリポジトリから選ぶ
  await choose(page, "移す先", "作ると決める");
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();

  await main.getByRole("tab", { name: "設定" }).click();
  // 変えていない項目は office の初期値を受け継ぐ
  await expect(main.getByText("office の初期値と同じ")).toHaveCount(5);
  const repoCard = main.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "リポジトリ", exact: true }) });
  await choose(page, "リポジトリ", OTHER_REPO);
  await repoCard.getByLabel("リポジトリを変える理由").fill("置き場を移す");
  await repoCard.getByRole("button", { name: "リポジトリを変える" }).click();
  await expect(repoCard.getByText(/リポジトリを変えました/)).toBeVisible();
  await expect(main.getByText(`リポジトリ: ${OTHER_REPO}、担当: 開発担当`)).toBeVisible();
  await main.getByRole("tab", { name: "設定" }).click();
  await choose(page, "リポジトリ", REPO);
  await repoCard.getByLabel("リポジトリを変える理由").fill("元に戻す");
  await repoCard.getByRole("button", { name: "リポジトリを変える" }).click();
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();

  // デプロイは GitHub の通知が残すので、通知の代わりに記録を置く
  seedMain(
    `INSERT INTO service_events (id, at, service_id, kind, by, detail) VALUES ('${crypto.randomUUID()}', ${String(Date.now())}, '${id}', 'deploy', 'system', '{"deploymentId":1,"version":"abc1234","commit":"${"a".repeat(40)}"}')`,
  );
  await fakeGitHubRoute(page, `GET /repos/${REPO}`, { full_name: REPO, private: false, default_branch: "main" });
  await fakeGitHubRoute(page, `POST /repos/${REPO}/actions/workflows/rollback.yml/dispatches`, {});
  await page.reload();
  await expect(main.getByText("abc1234")).toBeVisible();
  await main.getByRole("button", { name: "前のバージョンに戻す" }).click();
  await page.getByRole("dialog").getByLabel("戻す理由").fill("失敗が増えた");
  await page.getByRole("dialog").getByRole("button", { name: "戻す", exact: true }).click();
  await expect(main.getByText("戻すよう GitHub に頼みました")).toBeVisible();
  await main.getByRole("tab", { name: "記録" }).click();
  await expect(main.getByRole("tabpanel", { name: "記録" }).getByText(/前のバージョンに戻した\s*失敗が増えた/)).toBeVisible();
  expect(await dispatches(page)).toBe(before + 1);
});

test("案を見送ると、元の案に見送った理由が残る", async ({ page }) => {
  const title = `見送る案 ${crypto.randomUUID().slice(0, 8)}`;
  await addIdea(page, title);
  const main = page.getByRole("main");
  await choose(page, "移す先", "見送る");
  await move(page, "見送る", "今は手が回らない");
  // 見送った案は、それ以上移せない
  await expect(main.getByLabel("移す理由")).toHaveCount(0);
  await main.getByRole("tab", { name: "元の案" }).click();
  await expect(main.getByText("今は手が回らない")).toBeVisible();
});

test("デプロイの条件がそろわないとサービスにできず、足りない条件が画面に出る", async ({ page }) => {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  await chooseDocsRepo(page);
  await addIdea(page, `デプロイの条件の案 ${crypto.randomUUID().slice(0, 8)}`);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();
  // 設定の画面で、オーナーの承認にチェックとレビュー担当の承認を足す (足すだけなので、パスキーは要らない)
  await main.getByRole("tab", { name: "設定" }).click();
  const deploy = main.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "本番にデプロイする条件", exact: true }) });
  await deploy.getByRole("checkbox", { name: "チェックの合格" }).check();
  await deploy.getByRole("checkbox", { name: "レビュー担当の承認" }).check();
  await deploy.getByLabel("本番にデプロイする条件を変える理由").fill("チェックとレビューも見る");
  await deploy.getByRole("button", { name: "本番にデプロイする条件を変える" }).click();
  await expect(deploy.getByText(/本番にデプロイする条件を変えました/)).toBeVisible();
  // 既定のブランチの先のチェックはまだ終わっていない
  const head = "d".repeat(40);
  await fakeGitHubRoute(page, `GET /repos/${REPO}`, { full_name: REPO, private: false, default_branch: "main" });
  await fakeGitHubRoute(page, `GET /repos/${REPO}/git/ref/heads/main`, { ref: "refs/heads/main", object: { sha: head } });
  await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${head}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "in_progress", conclusion: null }] });
  await page.reload();
  await move(page, "サービスにする", "本番に出す");
  await expect(main.getByText("段階を移せませんでした")).toBeVisible();
  await expect(main.getByText(/足りない条件: checks .*、reviewer /)).toBeVisible();
  // 段階は試作のまま
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();
  await expect(main.getByRole("button", { name: "サービスにする" })).toBeVisible();

  // チェックが通り、レビュー担当が先のコミットを承認すれば、サービスに進める
  await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${head}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
  seedMain(
    `INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, checks, reviewer_verdict) VALUES ('${crypto.randomUUID()}', '${crypto.randomUUID()}', '${REPO}', 1, 'x', '${"a".repeat(40)}', '${head}', '[]', 'approve')`,
  );
  await main.getByRole("button", { name: "サービスにする" }).click();
  await expect(main.getByText("段階を移せませんでした")).toHaveCount(0);
  await expect(main.getByText("サービス", { exact: true }).first()).toBeVisible();
  await expect(main.getByRole("button", { name: "サービスにする" })).toHaveCount(0);
});

test.describe("段階ごとのオーナーの判断", () => {
  test("本番にデプロイする時にデプロイの条件を確かめる", async ({ page }) => {
    const before = await deployableService(page, true);
    const main = page.getByRole("main");
    await page.reload();
    await main.getByRole("button", { name: "本番にデプロイする" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "デプロイする", exact: true }).click();
    await expect(main.getByText("デプロイできませんでした")).toBeVisible();
    await expect(main.getByText(/足りない条件: checks .*、reviewer /)).toBeVisible();
    expect(await dispatchBodies(page, "deploy.yml")).toHaveLength(before);

    // チェックが通り、レビュー担当が先のコミットを承認すれば、確かめたコミットを sha に入れて main で動かす
    await meetDeployWhen(page);
    await main.getByRole("button", { name: "本番にデプロイする" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "デプロイする", exact: true }).click();
    await expect(main.getByText("デプロイするよう GitHub に頼みました")).toBeVisible();
    await expect(main.getByText("デプロイできませんでした")).toHaveCount(0);
    const sent = await dispatchBodies(page, "deploy.yml");
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)).toEqual({ ref: "main", inputs: { sha: DEPLOY_HEAD } });
  });

  test("main に入った時もデプロイの条件を確かめる", async ({ page }) => {
    // 条件はチェックとレビュー担当の承認だけにする。オーナーの承認を求めると、push では走らせずにボタンを待つ
    const before = await deployableService(page, false);
    // 先のコミットのチェックが終わらず、レビュー担当の承認も無ければ、main に push が入っても走らせない
    await pushMain(page);
    expect(await dispatchBodies(page, "deploy.yml")).toHaveLength(before);
    // ボタンで頼んでも同じ条件で断り、足りない条件が画面に出る
    const main = page.getByRole("main");
    await page.reload();
    await main.getByRole("button", { name: "本番にデプロイする" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "デプロイする", exact: true }).click();
    await expect(main.getByText(/足りない条件: checks .*、reviewer /)).toBeVisible();
    expect(await dispatchBodies(page, "deploy.yml")).toHaveLength(before);
    // そろえば、次の push でボタンと同じ口を通り、確かめたコミットを sha に入れて main で動かす
    await meetDeployWhen(page);
    await pushMain(page);
    const sent = await dispatchBodies(page, "deploy.yml");
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)).toEqual({ ref: "main", inputs: { sha: DEPLOY_HEAD } });
  });
});

test.describe("サービスごとの設定", () => {
  test("断られた後も今の値を出す", async ({ page }) => {
    await useOwnerPasskey(page);
    const id = await prototypeService(page, REPO, `断られる設定の案 ${crypto.randomUUID().slice(0, 8)}`);
    const main = page.getByRole("main");
    await main.getByRole("tab", { name: "設定" }).click();
    const deployWhen = settingCard(page, "本番にデプロイする条件");
    await expect(deployWhen.getByRole("checkbox", { name: "オーナーの承認" })).toBeChecked();

    // 同じ設定を読んだ別の画面で、先にチェックの合格を足す
    const other = await page.context().newPage();
    try {
      await other.goto(`/services/${id}`);
      await other.getByRole("main").getByRole("tab", { name: "設定" }).click();
      const elsewhere = settingCard(other, "本番にデプロイする条件");
      await elsewhere.getByRole("checkbox", { name: "チェックの合格" }).check();
      await elsewhere.getByLabel("本番にデプロイする条件を変える理由").fill("別の画面で足す");
      await elsewhere.getByRole("button", { name: "本番にデプロイする条件を変える" }).click();
      await expect(elsewhere.getByText(/本番にデプロイする条件を変えました/)).toBeVisible();
    } finally {
      await other.close();
    }

    // 前の版のままレビュー担当の承認を足すと 409 で断られ、知らせが残り、選び欄は別の画面で変えた今の値になる
    await deployWhen.getByRole("checkbox", { name: "レビュー担当の承認" }).check();
    await deployWhen.getByLabel("本番にデプロイする条件を変える理由").fill("前の版から足す");
    await deployWhen.getByRole("button", { name: "本番にデプロイする条件を変える" }).click();
    await expect(deployWhen.getByRole("checkbox", { name: "チェックの合格" })).toBeChecked();
    await expect(deployWhen.getByRole("checkbox", { name: "レビュー担当の承認" })).not.toBeChecked();
    const refused = deployWhen.getByRole("alert").filter({ hasText: "本番にデプロイする条件を変えられませんでした" });
    await expect(refused).toContainText("ほかの所で先に変わりました");
    await expect(refused).toContainText("問い合わせの番号");

    // main にマージする条件は書けたが、GitHub にルールセットを掛けられず 502 になる。知らせが残り、選び欄は書けた値になる
    await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/main/check-runs`, { total_count: 0, check_runs: [] });
    const rulesets = `GET ${new URL(FAKE_GITHUB).pathname}/repos/${REPO}/rulesets`;
    try {
      expect((await page.request.post(`${FAKE_GITHUB}/__fake/failures`, { data: { route: rulesets, status: 500, times: 5 } })).status()).toBe(204);
      const mergeWhen = settingCard(page, "main にマージする条件");
      await mergeWhen.getByRole("checkbox", { name: "オーナーの承認" }).check();
      await mergeWhen.getByLabel("main にマージする条件を変える理由").fill("オーナーも見る");
      await mergeWhen.getByRole("button", { name: "main にマージする条件を変える" }).click();
      const unapplied = mergeWhen.getByRole("alert").filter({ hasText: "main にマージする条件は変えましたが、GitHub に掛けられませんでした" });
      await expect(unapplied).toContainText("問い合わせの番号");
      await expect(mergeWhen.getByText("初期値から変えている")).toBeVisible();
      await expect(mergeWhen.getByRole("checkbox", { name: "オーナーの承認" })).toBeChecked();
      // 読み直した後も、前に断られた本番にデプロイする条件の知らせは残る
      await expect(refused).toBeVisible();
    } finally {
      expect((await page.request.delete(`${FAKE_GITHUB}/__fake/failures`)).status()).toBe(204);
    }
  });
});

test.describe("アイデアから運用までの流れ", () => {
  test("同じ名前のリポジトリを持つサービスがある", async ({ page }) => {
    await useOwnerPasskey(page);
    const first = await prototypeService(page, REPO, `先に作る案 ${crypto.randomUUID().slice(0, 8)}`);
    const docs = z.object({ data: z.object({ repo: z.string().nullable() }) }).parse(await (await page.request.get("/api/v1/devloop/docs-repo")).json()).data.repo;
    await addIdea(page, `後から作る案 ${crypto.randomUUID().slice(0, 8)}`);
    const main = page.getByRole("main");
    await move(page, "検討に進める", "調べる");
    await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
    await choose(page, "移す先", "作ると決める");
    // 選び欄には、先の案が持つリポジトリと設計書のリポジトリを並べない
    await main.getByRole("combobox", { name: "リポジトリ" }).click();
    await expect(page.getByRole("option", { name: OTHER_REPO, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: REPO, exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: docs ?? "設計書のリポジトリ", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: OTHER_REPO, exact: true }).click();

    // 選んだ後に、先の案が同じリポジトリに移る。作ると決めると、ほかで変わったとは言わずに重なる名前を出す
    seedMain(`UPDATE services SET repo = '${OTHER_REPO}' WHERE id = '${first}'`);
    await move(page, "作ると決める", "作る");
    const refused = main.getByRole("alert").filter({ hasText: "段階を移せませんでした" });
    await expect(refused).toContainText("同じ名前 (knowidea-ui) のリポジトリを持つサービス");
    await expect(refused).toContainText("名前の違うリポジトリを選ぶ");
    await expect(refused).not.toContainText("ほかの所で先に変わりました");
    await expect(refused).toContainText("問い合わせの番号");
    // 段階は検討のまま。読み直した選び欄には、移った先のリポジトリが並ばない
    await page.reload();
    await choose(page, "移す先", "作ると決める");
    await main.getByRole("combobox", { name: "リポジトリ" }).click();
    await expect(page.getByRole("option", { name: REPO, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: OTHER_REPO, exact: true })).toHaveCount(0);
  });
});
