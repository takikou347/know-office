import { expect, test } from "@playwright/test";
import { screens } from "../src/screen/routes.ts";

// どの画面も 3 つの幅で開き、横にはみ出さず、切り替えで今いる所が分かる
for (const s of screens) {
  test(`${s.label} (${s.path}) が開き、横にはみ出さない`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(s.path);
    await expect(page.getByRole("heading", { level: 1, name: s.label })).toBeVisible();

    // 部品の見た目と色の変数が読み込まれている (読み込まれないと、はみ出しの確かめが意味を持たない)
    const space = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--space-1").trim(),
    );
    expect(space).not.toBe("");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.locator('nav [aria-current="page"]:visible')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

test("最初に開くのはダッシュボード", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "ダッシュボード" })).toBeVisible();
});

test("その他から、下の切り替えに無い画面へ移れる", async ({ page }) => {
  await page.goto("/more");
  await expect(page.getByRole("heading", { level: 1, name: "その他" })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "記録" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "記録" })).toBeVisible();
});

test("社員と仕事で、社員を選ぶと会話と勤怠の表が出る", async ({ page }) => {
  await page.goto("/staff");
  await page.getByRole("main").getByRole("link", { name: /作る役/ }).click();
  await expect(page.getByRole("log", { name: "作る役との会話" })).toBeVisible();
  await page.getByRole("tab", { name: "勤怠" }).click();
  // 表の名前は、表を包む区画に付く
  const table = page.getByRole("region", { name: "作る役の勤怠" }).getByRole("table");
  await expect(table.getByRole("columnheader", { name: "始めた" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "終えた" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "仕事" })).toBeVisible();
});

test("社員と仕事で、変更のある仕事を選ぶと同じ画面にレビューが開く", async ({ page }) => {
  await page.goto("/staff");
  await page.getByRole("main").getByRole("link", { name: /作る役/ }).click();
  await page.getByRole("tab", { name: "仕事の山" }).click();
  await page.getByRole("link", { name: /CodeEditor のページを足す/ }).click();
  await expect(page.getByRole("heading", { name: "CodeEditor のページを足す" })).toBeVisible();
  await expect(page.getByRole("button", { name: "可", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "不可" })).toBeVisible();
});

test("画面が手元の入口とつながる", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("入口とつながりました")).toBeVisible();
});

// 一番幅の出る所も、3 つの幅で横にはみ出さない
for (const path of ["/staff/maker?tab=attendance", "/staff/maker/tasks/t2"]) {
  test(`${path} が横にはみ出さない`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "社員と仕事" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("スマートフォンの勤怠の表は 3 列を出し、行を開くと残りが出る", async ({ page }) => {
  await page.goto("/staff/maker?tab=attendance");
  const table = page.getByRole("region", { name: "作る役の勤怠" }).getByRole("table");
  await expect(table.getByRole("columnheader", { name: "仕事" })).toBeVisible();
  const phone = (page.viewportSize()?.width ?? 0) < 600;
  await expect(table.getByRole("columnheader", { name: "掛かった" })).toBeVisible({ visible: !phone });
  if (phone) {
    await table.locator("summary", { hasText: "DiffView の行番号を直す" }).click();
    await expect(table.getByText("掛かった 1 時間 40 分")).toBeVisible();
  }
});

test("勤怠の上の 1 行は、出勤から止められていた時間までを出す", async ({ page }) => {
  await page.goto("/staff/maker?tab=attendance");
  await expect(page.getByText(/出勤 9:00、退勤 17:10、働いた 7 時間 55 分、延長 10 分 \(区切りを待った\)、止められていた 0 分/)).toBeVisible();
});

test("レビューから戻ると、仕事の山のタブに戻る", async ({ page }) => {
  await page.goto("/staff/maker/tasks/t2");
  await page.getByRole("link", { name: "仕事の山に戻る" }).click();
  await expect(page.getByRole("tab", { name: "仕事の山" })).toHaveAttribute("aria-selected", "true");
});

test("スマートフォンで社員、仕事と進み、戻るで 1 つ前の列に戻る", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 600, "1 列になる幅だけ");
  await page.goto("/staff");
  await page.getByRole("main").getByRole("link", { name: /作る役/ }).click();
  await page.getByRole("tab", { name: "仕事の山" }).click();
  await page.getByRole("link", { name: /CodeEditor のページを足す/ }).click();
  await page.getByRole("button", { name: "仕事の山へ戻る" }).click();
  await expect(page.getByRole("tab", { name: "仕事の山" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "社員の一覧へ戻る" }).click();
  await expect(page.getByRole("main").getByRole("link", { name: /見る役/ })).toBeVisible();
});

test("その日だけの指示を出せる", async ({ page }) => {
  await page.goto("/staff/maker");
  await page.getByRole("button", { name: "延長する" }).click();
  await expect(page.getByText("作る役に延長を伝えました")).toBeVisible();
});

test("レビューで可を出すと、出した事が分かる", async ({ page }) => {
  await page.goto("/staff/maker/tasks/t2");
  await expect(page.getByRole("list").getByText("見る役とオーナーに可を頼んだ")).toBeVisible();
  await page.getByRole("button", { name: "可", exact: true }).click();
  await expect(page.getByText("可を出しました")).toBeVisible();
});

test("ダッシュボードに、可を待つ物、今日の仕事、今月の費用、お知らせが出る", async ({ page }) => {
  await page.goto("/");
  for (const name of ["社員の様子", "可を待つ物", "今日の仕事", "お知らせ"]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  await expect(page.getByText("今月の費用")).toBeVisible();
});

test("サービスを選ぶと、その様子と記録と設定が出る", async ({ page }) => {
  await page.goto("/services");
  await page.getByRole("main").getByRole("link", { name: "knowidea-ui" }).click();
  await page.getByRole("tab", { name: "設定" }).click();
  await expect(page.getByText("版を上げたら npm に出す")).toBeVisible();
});

test("止めている社員を、守りの画面から再開できる", async ({ page }) => {
  await page.goto("/guard");
  await page.getByRole("button", { name: "作る役を再開する" }).click();
  await expect(page.getByText("作る役を再開しました")).toBeVisible();
});

test("画面を移ると、題が変わり、中身に移る", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: /作る役/ }).first().click();
  await expect(page).toHaveTitle("社員と仕事 - know-office");
  await expect(page.getByRole("main")).toBeFocused();
});

test("画面を移ると、中身の先頭に戻り、中身に Tab で入れるままである", async ({ page }) => {
  // 記録も守りも長いので、移った先でも送った分が残りうる。送られるのは中身の main だけ
  await page.goto("/records");
  const main = page.getByRole("main");
  await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.locator("nav:visible").getByRole("link", { name: "守り" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "守り" })).toBeVisible();
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await expect(main).toBeFocused();
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(main).toHaveAttribute("tabindex", "0");
});

test("今いる画面のリンクを押しても、履歴は積まない", async ({ page }) => {
  await page.goto("/");
  const staffLink = page.locator("nav:visible").getByRole("link", { name: "社員と仕事" });
  await staffLink.click();
  await expect(page).toHaveURL(/\/staff$/);
  await staffLink.click();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});
