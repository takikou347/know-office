// アイデアとサービスの画面の通し。オーナーが画面で案を足し、検討して元の案をたどり、リポジトリを選んで作ると決め、設定でリポジトリを変え、前のバージョンに戻す。見送る案も画面で見送る。
// 画面から作れない検討の材料 (社長が出す) とデプロイの記録 (GitHub の通知が作る) だけを手元の D1 と R2 に置き、ゲートウェイの返事は差し替えない (サービスと拡張の 3.1 から 3.3)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";

const office = join(import.meta.dirname, "../..");

/** 代わりの GitHub がインストールで選ぶリポジトリ */
const REPO = "example/know-office";
const OTHER_REPO = "example/knowidea-ui";

/** 戻す workflow を動かす要求の道。代わりの GitHub は /github の下に立つ */
const DISPATCH = `POST /github/repos/${REPO}/actions/workflows/rollback.yml/dispatches`;

const Requests = z.array(z.object({ route: z.string() }).loose());

/**
 * 代わりの GitHub が受けた、戻す workflow を動かす要求の数
 * @param page 開いているページ
 * @returns 数
 */
async function dispatches(page: Page): Promise<number> {
  const all = Requests.parse(await (await page.request.get(`${FAKE_GITHUB}/__fake/requests`)).json());
  return all.filter((r) => r.route === DISPATCH).length;
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
  execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "put", `know-office-files/${key}`, "--local", `--file=${file}`], { cwd: office, stdio: "pipe" });
  seedMain(`UPDATE services SET study_key = '${key}' WHERE id = '${serviceId}'`);
}

/**
 * Knowidea-ui の選ぶ欄で 1 つ選ぶ
 * @param page 開いているページ
 * @param label 欄の名前
 * @param option 選ぶ物
 */
async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("main").getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * 画面の案を足す欄で案を足し、足した案の詳細を開く
 * @param page 開いているページ
 * @param title 案の名前
 * @returns 足した案のサービス ID
 */
async function addIdea(page: Page, title: string): Promise<string> {
  await page.goto("/services");
  const main = page.getByRole("main");
  await main.getByLabel("案の名前").fill(title);
  await choose(page, "種類", "Web アプリ");
  await main.getByLabel("狙い").fill("通しで確かめる案");
  await main.getByLabel("使う人").fill("オーナー");
  await main.getByLabel("月の費用の見込み (ドル)").fill("3.5");
  await main.getByRole("button", { name: "案を足す" }).click();
  await expect(main.getByRole("heading", { level: 2, name: title })).toBeVisible();
  const id = /\/services\/([0-9a-f-]{36})$/.exec(page.url())?.[1];
  if (id === undefined) throw new Error("足した案を開けない");
  return id;
}

/**
 * 段階を移す欄で、理由を書いて移す
 * @param page 開いているページ
 * @param button 移すボタンの文
 * @param reason 理由
 */
async function move(page: Page, button: string, reason: string): Promise<void> {
  const main = page.getByRole("main");
  await main.getByLabel("移す理由").fill(reason);
  await main.getByRole("button", { name: button }).click();
}

test.afterEach(() => {
  forgetGitHub();
});

test("案を足し、検討して元の案をたどり、リポジトリを選んで作り、設定を変えて前のバージョンに戻す", async ({ page }) => {
  await useOwnerPasskey(page);
  await page.goto("/services");
  await connectGitHub(page);
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
  await expect(main.getByText("3.50 ドル")).toBeVisible();

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
