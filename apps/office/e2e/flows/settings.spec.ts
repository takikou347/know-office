// 設定の画面の通し。オーナーが画面でサービスの初期値と勤務の時刻を変え、ほかの端末のセッションを切る。ゲートウェイの返事は差し替えない (サービスと拡張の 3.3、ログインと記録の 3.2)
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { cancelCard, editCard, part, pickTime, saveCard } from "./helpers/screen.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

/**
 * 設定の画面の、見出し (h3) の付いたカードを探す
 * @param page 開いているページ
 * @param title カードの題
 * @returns カード
 */
function card(page: Page, title: string): Locator {
  return page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
}

/**
 * PUT /api/v1/settings/{key} の返事を待つ
 * @param page 開いているページ
 * @param key 設定のキー
 * @param status 待つステータス
 * @returns 返事
 */
function settingPut(page: Page, key: string, status: number) {
  return page.waitForResponse((r) => r.url().endsWith(`/api/v1/settings/${key}`) && r.request().method() === "PUT" && r.status() === status);
}

/**
 * ほかの端末として画面を開き、ログインセッションを作る
 * @param browser ブラウザー
 * @param ip その端末の送信元
 * @returns その端末のページ
 */
async function otherDevice(browser: Browser, ip: string): Promise<Page> {
  const context = await browser.newContext({ userAgent: IPHONE, extraHTTPHeaders: { "CF-Connecting-IP": ip } });
  const other = await context.newPage();
  await other.goto("/settings");
  await expect(part(other, "セッションと鍵").getByText("(この端末)")).toBeVisible();
  expect(await other.evaluate(async () => (await fetch("/api/v1/me")).status)).toBe(200);
  return other;
}

/**
 * テストごとの、ほかの端末の送信元を作る。前に流した通しのセッションと見分ける
 * @returns 文書用の範囲 (RFC 3849) の IP
 */
function freshIp(): string {
  return `2001:db8:f10e:${Math.floor(Math.random() * 0xffff).toString(16)}::${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

test.describe("サービスごとの設定", () => {
  test("office の初期値を変える", async ({ page }) => {
    const label = "main にマージする条件";
    await useOwnerPasskey(page);
    await page.goto("/settings");
    const merge = card(page, label);
    const owner = merge.getByRole("checkbox", { name: "オーナーの承認" });
    // 組み込みの初期値の印は出さず、今の値だけを出す
    await expect(merge.getByText("組み込みの初期値")).toHaveCount(0);
    await editCard(merge, label);
    await expect(merge.getByRole("checkbox", { name: "チェックの合格" })).toBeChecked();
    if (await owner.isChecked()) {
      // 前の通しが途中で落ちて条件を足したままなら、先に外して初期の値から始める
      await owner.uncheck();
      await saveCard(merge, label, "前の通しの残りを戻す");
      await expect(merge.getByText(/main にマージする条件を変えました/)).toBeVisible();
      // 戻す時に通したパスキーの確認を残さないよう、ログインセッションを作り直す
      await page.context().clearCookies();
      await page.reload();
      await editCard(merge, label);
      await expect(owner).not.toBeChecked();
    }

    // 条件を足すのは守りを強めるので、パスキーを求められない。保存すると入力を閉じ、今の値に戻る
    await owner.check();
    const strengthened = settingPut(page, "service.mergeWhen", 200);
    await saveCard(merge, label, "main はオーナーも見る");
    await strengthened;
    await expect(merge.getByText(/main にマージする条件を変えました \(バージョン \d+\)/)).toBeVisible();
    await expect(owner).toHaveCount(0);
    await expect(merge.getByText(/^チェックの合格、.*オーナーの承認$/)).toBeVisible();

    // 読み直しても、足した条件が出る
    await page.reload();
    await expect(merge.getByText(/^チェックの合格、.*オーナーの承認$/)).toBeVisible();
    await editCard(merge, label);
    await expect(owner).toBeChecked();
    await expect(merge.getByRole("checkbox", { name: "チェックの合格" })).toBeChecked();

    // 条件を外すのは守りを弱めるので、パスキーで確かめてから 1 度だけ送り直す
    const refused = settingPut(page, "service.mergeWhen", 401);
    const confirmed = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/step-up") && r.status() === 200);
    await owner.uncheck();
    await saveCard(merge, label, "元に戻す");
    await refused;
    await confirmed;
    await expect(merge.getByText(/main にマージする条件を変えました/)).toBeVisible();
    await page.reload();
    await expect(merge.getByText(/^チェックの合格/)).toBeVisible();
    await expect(merge.getByText(/オーナーの承認$/)).toHaveCount(0);
  });

  test("条件を 1 つも選ばないと、変えるボタンを押せない", async ({ page }) => {
    const label = "本番にデプロイする条件";
    await page.goto("/settings");
    const deploy = card(page, label);
    await editCard(deploy, label);
    await deploy.getByRole("checkbox", { name: "オーナーの承認" }).uncheck();
    await expect(deploy.getByText("条件は 1 つ以上選んでください")).toBeVisible();
    // 形の合わない間は、理由を書いても保存を押せない
    await deploy.getByLabel(`${label}を変える理由`).fill("外す");
    await expect(deploy.getByRole("button", { name: `${label}を保存` })).toBeDisabled();
    // 取り消すと入力を閉じ、今の値に戻る
    await cancelCard(deploy, label);
    await expect(deploy.getByText("オーナーの承認", { exact: true })).toBeVisible();
  });
});

test.describe("勤務の時間", () => {
  test("時刻を変える", async ({ page }) => {
    const label = "勤務の時刻";
    await useOwnerPasskey(page);
    await page.goto("/settings");
    const schedule = card(page, label);
    await editCard(schedule, label);
    await expect(schedule.getByRole("combobox", { name: "終わり (日本時間)" })).toHaveText(/\d\d:\d\d/);
    if (!(await schedule.getByRole("combobox", { name: "終わり (日本時間)" }).innerText()).includes("17:00")) {
      // 前の通しが途中で落ちて時刻を変えたままなら、先に初期の時刻へ戻す
      await pickTime(schedule, "始まり (日本時間)", "09:00");
      await pickTime(schedule, "終わり (日本時間)", "17:00");
      await saveCard(schedule, label, "前の通しの残りを戻す");
      await expect(schedule.getByText(/勤務の時刻を変えました/)).toBeVisible();
      // 戻す時に通したパスキーの確認を残さないよう、ログインセッションを作り直す
      await page.context().clearCookies();
      await page.reload();
      await editCard(schedule, label);
    }
    await expect(schedule.getByRole("combobox", { name: "始まり (日本時間)" })).toHaveText("09:00");

    // 終わりを遅らせると勤務が延びるので、パスキーで確かめてから 1 度だけ送り直す
    await pickTime(schedule, "始まり (日本時間)", "10:00");
    await pickTime(schedule, "終わり (日本時間)", "18:00");
    const refused = settingPut(page, "workday.schedule", 401);
    await saveCard(schedule, label, "朝を遅くする");
    await refused;
    await expect(schedule.getByText(/勤務の時刻を変えました \(バージョン \d+\)/)).toBeVisible();
    await expect(schedule.getByText(/^10:00 から 18:00 \(日本時間\)/)).toBeVisible();

    await page.reload();
    await expect(schedule.getByText(/^10:00 から 18:00 \(日本時間\)/)).toBeVisible();

    // 次の通しのために初期の時刻へ戻す。確認は 15 分有効
    await editCard(schedule, label);
    await expect(schedule.getByRole("combobox", { name: "始まり (日本時間)" })).toHaveText("10:00");
    await pickTime(schedule, "始まり (日本時間)", "09:00");
    await pickTime(schedule, "終わり (日本時間)", "17:00");
    await saveCard(schedule, label, "元に戻す");
    await expect(schedule.getByText(/勤務の時刻を変えました/)).toBeVisible();
    await page.reload();
    await expect(schedule.getByText(/^09:00 から 17:00 \(日本時間\)/)).toBeVisible();
  });
});

test.describe("セッション", () => {
  test("セッションを切る", async ({ page, browser }) => {
    const ip = freshIp();
    const other = await otherDevice(browser, ip);
    await page.goto("/settings");
    const sessions = part(page, "セッションと鍵");
    const row = sessions.getByRole("listitem").filter({ hasText: ip });
    await expect(row).toContainText("iPhone の Safari");

    await row.getByRole("button", { name: /iPhone の Safariのセッションを切る/ }).click();
    await expect(sessions.getByText("iPhone の Safariのセッションを切りました")).toBeVisible();
    await expect(sessions.getByRole("listitem").filter({ hasText: ip })).toHaveCount(0);
    // 切った端末の次の要求は断られる
    expect(await other.evaluate(async () => (await fetch("/api/v1/me")).status)).toBe(401);
    await other.context().close();
  });

  test("ほかのセッションをすべて切ると、この端末だけが残る", async ({ page, browser }) => {
    const first = await otherDevice(browser, freshIp());
    const second = await otherDevice(browser, freshIp());
    await page.goto("/settings");
    const sessions = part(page, "セッションと鍵");
    await expect(sessions.getByRole("listitem").filter({ hasText: "(この端末)" })).toHaveCount(1);

    await sessions.getByRole("button", { name: "ほかのセッションをすべて切る" }).click();
    await expect(sessions.getByText("この端末のほかのセッションをすべて切りました")).toBeVisible();
    await expect(sessions.getByRole("listitem")).toHaveCount(1);
    await expect(sessions.getByRole("listitem")).toContainText("(この端末)");
    await expect(sessions.getByRole("button", { name: "ほかのセッションをすべて切る" })).toBeDisabled();
    for (const other of [first, second]) {
      expect(await other.evaluate(async () => (await fetch("/api/v1/me")).status)).toBe(401);
      await other.context().close();
    }
  });
});
