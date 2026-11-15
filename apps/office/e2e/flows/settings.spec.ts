// 設定の画面の通し。オーナーが画面でサービスの初期値と勤務の時刻を変え、ほかの端末のセッションを切る。ゲートウェイの返事は差し替えない (サービスと拡張の 3.3、ログインと記録の 3.2)
import type { Browser, Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { part } from "./helpers/screen.ts";

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
 * カードの中の理由を書いて、変えるボタンを押す
 * @param box カード
 * @param label 項目の名前
 * @param reason 理由
 */
async function save(box: Locator, label: string, reason: string): Promise<void> {
  await box.getByLabel(`${label}を変える理由`).fill(reason);
  await box.getByRole("button", { name: `${label}を変える` }).click();
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
    await useOwnerPasskey(page);
    await page.goto("/settings");
    const merge = card(page, "main にマージする条件");
    const owner = merge.getByRole("checkbox", { name: "オーナーの承認" });
    await expect(merge.getByRole("checkbox", { name: "チェックの合格" })).toBeChecked();
    if (await owner.isChecked()) {
      // 前の通しが途中で落ちて条件を足したままなら、先に外して初期の値から始める
      await owner.uncheck();
      await save(merge, "main にマージする条件", "前の通しの残りを戻す");
      await expect(merge.getByText(/main にマージする条件を変えました/)).toBeVisible();
      // 戻す時に通したパスキーの確認を残さないよう、ログインセッションを作り直す
      await page.context().clearCookies();
      await page.reload();
      await expect(owner).not.toBeChecked();
    }

    // 条件を足すのは守りを強めるので、パスキーを求められない
    await owner.check();
    const strengthened = settingPut(page, "service.mergeWhen", 200);
    await save(merge, "main にマージする条件", "main はオーナーも見る");
    await strengthened;
    await expect(merge.getByText(/main にマージする条件を変えました \(バージョン \d+\)/)).toBeVisible();

    // 読み直しても、足した条件が出る
    await page.reload();
    await expect(card(page, "main にマージする条件").getByRole("checkbox", { name: "オーナーの承認" })).toBeChecked();
    await expect(card(page, "main にマージする条件").getByRole("checkbox", { name: "チェックの合格" })).toBeChecked();

    // 条件を外すのは守りを弱めるので、パスキーで確かめてから 1 度だけ送り直す
    const refused = settingPut(page, "service.mergeWhen", 401);
    const confirmed = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/step-up") && r.status() === 200);
    await card(page, "main にマージする条件").getByRole("checkbox", { name: "オーナーの承認" }).uncheck();
    await save(card(page, "main にマージする条件"), "main にマージする条件", "元に戻す");
    await refused;
    await confirmed;
    await expect(card(page, "main にマージする条件").getByText(/main にマージする条件を変えました/)).toBeVisible();
    await page.reload();
    await expect(card(page, "main にマージする条件").getByRole("checkbox", { name: "オーナーの承認" })).not.toBeChecked();
  });

  test("条件を 1 つも選ばないと、変えるボタンを押せない", async ({ page }) => {
    await page.goto("/settings");
    const deploy = card(page, "本番にデプロイする条件");
    await deploy.getByRole("checkbox", { name: "オーナーの承認" }).uncheck();
    await expect(deploy.getByText("条件は 1 つ以上選んでください")).toBeVisible();
    // 形の合わない間は、理由も書けない
    await expect(deploy.getByLabel("本番にデプロイする条件を変える理由")).toBeDisabled();
    await expect(deploy.getByRole("button", { name: "本番にデプロイする条件を変える" })).toBeDisabled();
  });
});

test.describe("勤務の時間", () => {
  test("勤務の時刻を 10 時から 18 時に変えると、読み直しても出る", async ({ page }) => {
    await useOwnerPasskey(page);
    await page.goto("/settings");
    const schedule = card(page, "勤務の時刻");
    await expect(schedule.getByLabel("終わり (日本時間)")).toHaveValue(/^\d\d:\d\d$/);
    if ((await schedule.getByLabel("終わり (日本時間)").inputValue()) !== "17:00") {
      // 前の通しが途中で落ちて時刻を変えたままなら、先に初期の時刻へ戻す
      await schedule.getByLabel("始まり (日本時間)").fill("09:00");
      await schedule.getByLabel("終わり (日本時間)").fill("17:00");
      await save(schedule, "勤務の時刻", "前の通しの残りを戻す");
      await expect(schedule.getByText(/勤務の時刻を変えました/)).toBeVisible();
      // 戻す時に通したパスキーの確認を残さないよう、ログインセッションを作り直す
      await page.context().clearCookies();
      await page.reload();
    }
    await expect(schedule.getByLabel("始まり (日本時間)")).toHaveValue("09:00");

    // 終わりを遅らせると勤務が延びるので、パスキーで確かめてから 1 度だけ送り直す
    await schedule.getByLabel("始まり (日本時間)").fill("10:00");
    await schedule.getByLabel("終わり (日本時間)").fill("18:00");
    const refused = settingPut(page, "workday.schedule", 401);
    await save(schedule, "勤務の時刻", "朝を遅くする");
    await refused;
    await expect(schedule.getByText(/勤務の時刻を変えました \(バージョン \d+\)/)).toBeVisible();

    await page.reload();
    await expect(card(page, "勤務の時刻").getByLabel("始まり (日本時間)")).toHaveValue("10:00");
    await expect(card(page, "勤務の時刻").getByLabel("終わり (日本時間)")).toHaveValue("18:00");

    // 次の通しのために初期の時刻へ戻す。確認は 15 分有効
    await card(page, "勤務の時刻").getByLabel("始まり (日本時間)").fill("09:00");
    await card(page, "勤務の時刻").getByLabel("終わり (日本時間)").fill("17:00");
    await save(card(page, "勤務の時刻"), "勤務の時刻", "元に戻す");
    await expect(card(page, "勤務の時刻").getByText(/勤務の時刻を変えました/)).toBeVisible();
    await page.reload();
    await expect(card(page, "勤務の時刻").getByLabel("始まり (日本時間)")).toHaveValue("09:00");
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
