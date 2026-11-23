import { expect, test } from "./helpers/test.ts";
import { screens } from "../src/screen/routes.ts";
import { REVIEW_PATH, stubReview } from "./helpers/review.ts";

/** 幅で形の変わらない中身は、幅 1,280 だけで見る。狭い幅の形は、画面ごとのはみ出しと a11y.spec.ts で見る */
const WIDE_ONLY = "幅で形の変わらない中身なので、幅 1,280 だけで見る";

/**
 * 狭い幅のプロジェクトかを返す
 * @param page 開くページ
 * @returns 幅が 600 より狭ければ true
 */
const narrow = (page: { viewportSize: () => { width: number } | null }) => (page.viewportSize()?.width ?? 0) < 600;

// どの画面も設定の幅で開き、横にはみ出さず、切り替えで今いる所が分かる
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

test.describe("画面の一覧", () => {
  test("最初に開く", async ({ page }) => {
    // ログインした後に開く入口の道は / で、ダッシュボードを出し、切り替えでも今いる所にする
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
    await expect(page.locator('nav:visible [aria-current="page"]')).toHaveText(/ホーム/);
  });
});

test("その他から、下の切り替えに無い画面へ移れる", async ({ page }) => {
  await page.goto("/more");
  await expect(page.getByRole("heading", { level: 1, name: "その他" })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "記録" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "記録" })).toBeVisible();
});

test("社員と仕事で、社員を選ぶと会話と勤怠の表が出る", async ({ page }) => {
  await page.goto("/staff");
  await page.getByRole("main").getByRole("link", { name: /開発担当/ }).click();
  await expect(page.getByRole("log", { name: "開発担当との会話" })).toBeVisible();
  await page.getByRole("tab", { name: "勤怠" }).click();
  // 表の名前は、表を包む区画に付く
  const table = page.getByRole("region", { name: "開発担当の勤怠" }).getByRole("table");
  await expect(table.getByRole("columnheader", { name: "始めた" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "終えた" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "仕事" })).toBeVisible();
});

test.describe("画面の一覧", () => {
  test("タスクからレビューに移る", async ({ page }) => {
    await stubReview(page);
    await page.goto("/staff");
    await page.getByRole("main").getByRole("link", { name: /開発担当/ }).click();
    await page.getByRole("tab", { name: "仕事の山" }).click();
    await page.getByRole("link", { name: /空の日の勤怠を 0 で出す/ }).click();
    // 同じ社員とタスクの画面のまま、右にレビューが開く
    await expect(page).toHaveURL(new RegExp(`${REVIEW_PATH}$`));
    await expect(page.getByRole("heading", { level: 1, name: "社員" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "空の日の勤怠を 0 で出す" })).toBeVisible();
    await expect(page.getByRole("button", { name: "承認する" })).toBeVisible();
    await expect(page.getByRole("button", { name: "差し戻す" })).toBeVisible();
  });
});

// 一番幅の出る所も、どの幅でも横にはみ出さない
for (const path of ["/staff/builder?tab=attendance&day=2026-11-13", REVIEW_PATH]) {
  test(`${path} が横にはみ出さない`, async ({ page }) => {
    await stubReview(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "社員" })).toBeVisible();
    // 勤怠の表は記録を読み終えてから幅を測る
    if (path.includes("attendance")) await expect(page.getByText(/出勤 9:00/)).toBeVisible();
    else await expect(page.locator(".ki-diff").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

// 3-workday の要件。狭い幅では始めた、終えた、仕事の 3 列を出し、行を開くと残りが出る。広い幅では全部の列を出す
test.describe("日ごとのタスク", () => {
  test("スマートフォンで勤怠を見る", async ({ page }) => {
    await page.goto("/staff/builder?tab=attendance&day=2026-11-13");
    const table = page.getByRole("region", { name: "開発担当の勤怠" }).getByRole("table");
    await expect(table.getByRole("columnheader", { name: "始めた" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "終えた" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "仕事" })).toBeVisible();
    const phone = narrow(page);
    await expect(table.getByRole("columnheader", { name: "掛かった" })).toBeVisible({ visible: !phone });
    if (phone) {
      await table.locator("summary", { hasText: "DiffView の行番号を直す" }).click();
      await expect(table.getByText("掛かった 1 時間 40 分")).toBeVisible();
    }
  });
});

test.describe("言葉と時刻", () => {
  test("時刻の表示", async ({ page }) => {
    // e2e/seed.sql の出勤と最初の仕事は 2026-11-13T00:00:00Z (協定世界時の 0 時) に始まる。日本時間の 9:00 で出す
    await page.goto("/staff/builder?tab=attendance&day=2026-11-13");
    await expect(page.getByText(/11\/13 \(金\) 出勤 9:00、/)).toBeVisible();
    const table = page.getByRole("region", { name: "開発担当の勤怠" }).getByRole("table");
    await expect(table.getByRole("row").nth(1)).toContainText("9:00");
    await expect(table.getByRole("row").nth(1)).not.toContainText("0:00");
  });
});

test("勤怠の上の 1 行は、出勤から止められていた時間までを出す", async ({ page }) => {
  test.skip(narrow(page), WIDE_ONLY);
  // records.setup.ts が手元の D1 に置いた記録を、入口から読んで出す
  await page.goto("/staff/builder?tab=attendance&day=2026-11-13");
  await expect(
    page.getByText("11/13 (金) 出勤 9:00、退勤 17:10、働いた 7 時間 55 分、延長 10 分 (チェックポイントを待った)、止められていた 15 分 (自動停止)"),
  ).toBeVisible();
  const table = page.getByRole("region", { name: "開発担当の勤怠" }).getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("row").nth(1)).toContainText("DiffView の行番号を直す");
  await expect(table.getByRole("row").nth(3)).toContainText("勤怠の表の画面を作る");
});

test("記録の画面で、サービスごとの内訳の最後に全体を出し、CSV で出せる", async ({ page }) => {
  test.skip(narrow(page), WIDE_ONLY);
  // records.setup.ts が手元の D1 に置いた work_entries を、期間を決めずに入口から集める
  await page.goto("/records?tab=tasks");
  const table = page.getByRole("region", { name: "サービスごとの掛けた時間" }).getByRole("table");
  await expect(table.getByRole("row", { name: /knowidea-ui/ })).toBeVisible();
  await expect(table.getByRole("row").last()).toContainText("全体");
  const link = page.getByRole("link", { name: "CSV で出す" });
  const res = await page.request.get((await link.getAttribute("href")) ?? "");
  expect(res.headers()["content-type"]).toMatch(/^text\/csv/);
  expect((await res.text()).trim().split("\r\n").at(-1)).toMatch(/^total,全体,/);
});

test("記録の画面で社員ごとに切り替えると、社員ごとの内訳の最後に全体を出す", async ({ page }) => {
  test.skip(narrow(page), WIDE_ONLY);
  await page.goto("/records?tab=tasks");
  await page.getByRole("radio", { name: "社員ごと" }).check();
  const table = page.getByRole("region", { name: "社員ごとの掛けた時間" }).getByRole("table");
  await expect(table.getByRole("row", { name: /開発担当/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /社長/ })).toBeVisible();
  await expect(table.getByRole("row").last()).toContainText("全体");
  await expect(page.getByRole("link", { name: "CSV で出す" })).toHaveAttribute("href", /group=staff/);
});

test("記録を種類ごとに見る", async ({ page }) => {
  test.skip(narrow(page), WIDE_ONLY);
  // records.setup.ts が手元の D1 に置いた記録を、タブごとに選んだ月の値で入口から集める
  await page.goto("/records");
  const tabs = page.getByRole("tablist", { name: "記録の種類" });
  for (const [tab, region] of [
    ["タスク", "サービスごとの掛けた時間"],
    ["費用", "サービスごとの費用"],
    ["トークン", "サービスごとのトークン"],
  ] as const) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("region", { name: region }).getByRole("row").last()).toContainText("全体");
    await expect(page.getByRole("link", { name: "CSV で出す" })).toHaveAttribute("href", /&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
  }
  await tabs.getByRole("tab", { name: "エラー" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "稼働率" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "エラーログ" })).toBeVisible();
});

test("記録の内訳を読めない時は、理由と問い合わせの番号を出す", async ({ page }) => {
  test.skip(narrow(page), WIDE_ONLY);
  await page.route("**/api/v1/records/summary?*", (route) =>
    route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify({ code: "internal", traceId: "0af7651916cd43dd8448eb211c80319c" }) }),
  );
  await page.goto("/records?tab=tasks");
  const alert = page.getByRole("alert").filter({ hasText: "記録を読めませんでした" });
  await expect(alert).toContainText("理由: internal");
  await expect(alert).toContainText("0af7651916cd43dd8448eb211c80319c");
});

test("レビューから戻ると、仕事の山のタブに戻る", async ({ page }) => {
  await stubReview(page);
  await page.goto(REVIEW_PATH);
  await page.getByRole("link", { name: "仕事の山に戻る" }).click();
  await expect(page.getByRole("tab", { name: "仕事の山" })).toHaveAttribute("aria-selected", "true");
});

test.describe("画面の一覧", () => {
  test("スマートフォンで深く進む", async ({ page }) => {
    test.skip(!narrow(page), "1 列になる幅だけ");
    await page.goto("/staff");
    await stubReview(page);
    // 1 列ずつ右へ進む。社員を選ぶと一覧は隠れ、会話とタスクの列だけになる
    await page.getByRole("main").getByRole("link", { name: /開発担当/ }).click();
    await expect(page.getByRole("main").getByRole("link", { name: /レビュー担当/ })).toBeHidden();
    await page.getByRole("tab", { name: "仕事の山" }).click();
    await page.getByRole("link", { name: /空の日の勤怠を 0 で出す/ }).click();
    await expect(page.getByRole("heading", { name: "空の日の勤怠を 0 で出す" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "仕事の山" })).toBeHidden();
    // 戻るで 1 つ前の列に戻る
    await page.getByRole("button", { name: "仕事の山へ戻る" }).click();
    await expect(page.getByRole("tab", { name: "仕事の山" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "社員の一覧へ戻る" }).click();
    await expect(page.getByRole("main").getByRole("link", { name: /レビュー担当/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("設定と記録の置き場を分ける", () => {
  test("サービスの設定を開く", async ({ page }) => {
    test.skip(narrow(page), WIDE_ONLY);
    await page.goto("/services");
    await page.getByRole("main").getByRole("link", { name: "knowidea-ui" }).click();
    await expect(page.getByText("公開した版")).toBeVisible();
    await page.getByRole("tab", { name: "設定" }).click();
    // サービスごとの設定はサービスの画面に出る。登録した時から本番にデプロイする条件を変えてある
    await expect(page.getByRole("heading", { level: 3, name: "本番にデプロイする条件" })).toBeVisible();
    await expect(page.getByText("初期値から変えている")).toBeVisible();
    // 設計書から作った Issue がまだ無いサービスの Issue のタブ
    await page.getByRole("tab", { name: "Issue" }).click();
    await expect(page.getByText("Issue がありません")).toBeVisible();
  });
});

test("画面を移ると、題が変わり、中身に移る", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: "すべて見る" }).click();
  await expect(page).toHaveTitle("承認 - know-office");
  await expect(page.getByRole("main")).toBeFocused();
});

test("画面を移った直後に Tab を押しても、中身の先頭から進む", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  // 描き直しを待たずに確かめる。次の描画まで中身に移らないと、その間に押した Tab の行き先が、後から中身に戻される
  const active = await page.evaluate(async () => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('nav a[href="/staff"]')].find((a) => a.getClientRects().length > 0);
    const before = document.title;
    link?.click();
    // 題は中身に移るのと同じ時に変わる。描画もタイマーも挟まず、microtask だけで待つ
    for (let n = 0; document.title === before && n < 1000; n++) await Promise.resolve();
    return { tag: document.activeElement?.tagName, title: document.title };
  });
  expect(active).toEqual({ tag: "MAIN", title: "社員 - know-office" });
});

test("ハッシュだけが違う同じ道へ移っても中身に移り、その後のタブの切り替えでは移らない", async ({ page }) => {
  // 幅が狭いと社員の画面に一覧が出ないので、どの幅でも出る下のナビゲーションから同じ道へ移る
  await page.goto("/staff#x");
  const main = page.getByRole("main");
  await page.locator("nav:visible").getByRole("link", { name: "社員" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(main).toBeFocused();
  await main.getByRole("link", { name: /開発担当/ }).first().click();
  await expect(main).toBeFocused();
  const tab = page.getByRole("tab", { name: "仕事の山" });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(main).not.toBeFocused();
});

test("画面を移ると、中身の先頭に戻り、中身に Tab で入れるままである", async ({ page }) => {
  // 記録も守りも長いので、移った先でも送った分が残りうる。送られるのは中身の main だけ
  await page.goto("/records?tab=tasks");
  // サービスごとの内訳を読み終えるまでは、記録の画面は送るほど長くない
  await expect(page.getByRole("link", { name: "CSV で出す" })).toBeVisible();
  const main = page.getByRole("main");
  await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.locator("nav:visible").getByRole("link", { name: "ハーネス" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ハーネス" })).toBeVisible();
  // 守りの画面は開いた時に読むので、読み終えて中身が長くなってから確かめる
  await expect(main.getByText("画面を読んでいます")).toBeHidden();
  expect(await main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await expect(main).toBeFocused();
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(main).toHaveAttribute("tabindex", "0");
});

test("今いる画面のリンクを押しても、履歴は積まない", async ({ page }) => {
  await page.goto("/");
  const staffLink = page.locator("nav:visible").getByRole("link", { name: "社員" });
  await staffLink.click();
  await expect(page).toHaveURL(/\/staff$/);
  await staffLink.click();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("目標の画面で、目標を進み具合のカードで並べ、開くとタスクを状態の 4 列で見せる", async ({ page }) => {
  await page.goto("/goals");
  const main = page.getByRole("main");
  const card = main.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "know-office を動かし始める" }) });
  await expect(card.getByText("目的: AI の社員が自分で回る会社にする")).toBeVisible();
  await expect(card.getByRole("progressbar", { name: "know-office を動かし始めるの進み具合" })).toHaveAttribute("aria-valuenow", "50");
  await expect(card.getByText("タスク 2 件のうち 1 件が完了")).toBeVisible();
  await card.getByRole("link", { name: "know-office を動かし始める" }).click();
  await expect(page).toHaveURL(/\/goals\/019a7b00-0000-7000-8000-0000000000d2$/);
  await expect(main.getByRole("heading", { level: 2, name: "know-office を動かし始める" })).toBeVisible();
  const todo = main.getByRole("region", { name: "未着手", exact: true });
  await expect(todo.getByRole("heading", { level: 4, name: "勤怠の訂正を出す" })).toBeVisible();
  await expect(main.getByRole("region", { name: "完了", exact: true }).getByRole("heading", { level: 4, name: "勤怠の表の画面を作る" })).toBeVisible();
  await expect(main.getByRole("region", { name: "進行中", exact: true }).getByText("データがありません")).toBeVisible();
  await main.getByRole("link", { name: "目標の一覧へ戻る" }).click();
  await expect(card).toBeVisible();
});

test("左上のロゴでホームへ戻り、サイドメニューの開け閉めと明るさを覚える", async ({ page }) => {
  test.skip(narrow(page), "サイドメニューと左上のロゴは幅 1,024 以上だけに出る");
  await page.goto("/settings");
  const side = page.locator("nav:visible");
  // 左上のロゴと名前はホームへのリンク
  await page.getByRole("link", { name: "know-office" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  // 閉じると名前が見えなくなり、読み込み直しても閉じたまま。開け直すと戻る
  const toggle = page.getByRole("button", { name: "サイドメニュー" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByRole("button", { name: "サイドメニュー" })).toHaveAttribute("aria-expanded", "false");
  await expect(side.getByRole("link", { name: "社員" })).toBeVisible();
  await page.getByRole("button", { name: "サイドメニュー" }).click();
  await expect(page.getByRole("button", { name: "サイドメニュー" })).toHaveAttribute("aria-expanded", "true");
  // 明るさを切り替えると html に付き、読み込み直しても残る
  const before = await page.evaluate(() => document.documentElement.dataset["theme"] ?? "");
  await page.getByRole("button", { name: /にする$/ }).click();
  const after = await page.evaluate(() => document.documentElement.dataset["theme"] ?? "");
  expect(after).not.toBe(before);
  expect(["light", "dark"]).toContain(after);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBe(after);
});
