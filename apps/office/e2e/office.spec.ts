import type { Page, Request } from "@playwright/test";
import { expect, test } from "./helpers/test.ts";
import { roomOf } from "./helpers/room.ts";
import { withoutWebgl } from "./helpers/webgl.ts";

// オフィスの 3D の部屋。社員を押すと会話に移り、ほかの画面では 3D を読まず、3D を出せない時は 2D の一覧に代える。
// 社員の動きと出来事は、社員を出勤させられる利用場面の通し (flows/office.spec.ts) で見る。画面の全体の 3.2

/** 3D のコード (three.js と部屋の作り) とエディタのコードの要求か。開発の入口は 1 つずつ、作った物は分けた塊で出す */
const heavy = /three|OfficeScene|pages\/office\/(room|figure|furniture|marks|plan|vrm|gltf|themes)|codemirror|knowidea-ui_editor|editor-/i;

/**
 * 開いたページで出た要求の URL を貯める
 * @param page 見るページ
 * @returns 貯めた URL の並び
 */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r: Request) => urls.push(new URL(r.url()).pathname));
  return urls;
}

/** 読み込む物と動きは幅で変わらないので、幅 1,280 だけで見る。狭い幅の部屋の形は、画面ごとのはみ出しと a11y.spec.ts で見る */
const WIDE_ONLY = "読み込む物と動きは幅で変わらないので、幅 1,280 だけで見る";

/**
 * 狭い幅のプロジェクトかを返す
 * @param page 開くページ
 * @returns 幅が 600 より狭ければ true
 */
const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 600;

test.describe("画面の一覧", () => {
  test("オフィスから会話に移る", async ({ page }) => {
    await page.goto("/office");
    const room = roomOf(page);
    await expect(room.locator("canvas")).toBeVisible();
    // 社員の名札を押す。休憩所で待つ社員が並ぶと姿を覆う所は重なるが、名札は重ならないようずらし、ほかの社員の箱より上に置いてある
    await room.getByText("開発担当", { exact: true }).click();
    await expect(page).toHaveURL(/\/staff\/builder$/);
    await expect(page.getByRole("log", { name: "開発担当との会話" })).toBeVisible();
  });
});

test.describe("速さ", () => {
  test("3D を読み込まない", async ({ page }) => {
    test.skip(narrow(page), WIDE_ONLY);
    const urls = recordRequests(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "ダッシュボード" })).toBeVisible();
    await expect(page.getByText("入口とつながりました")).toBeVisible();
    expect(urls.filter((u) => heavy.test(u))).toEqual([]);

    // 確かめ方が効いている事: オフィスを開くと 3D のコードを読む
    await page.goto("/office");
    await expect(roomOf(page).locator("canvas")).toBeVisible();
    expect(urls.some((u) => /three/.test(u))).toBe(true);
  });
});

test.describe("オフィスの部屋", () => {
  test("WebGL が無い時は 2D の一覧", async ({ page }) => {
    await withoutWebgl(page);
    const urls = recordRequests(page);
    await page.goto("/office");
    const list = page.getByRole("list", { name: "社員の様子" });
    await expect(list.getByRole("link", { name: /開発担当/ })).toBeVisible();
    await expect(page.getByRole("main").getByRole("status")).toHaveText("直近の出来事はまだありません");
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(urls.filter((u) => /three/.test(u))).toEqual([]);
    await list.getByRole("link", { name: /開発担当/ }).click();
    await expect(page.getByRole("log", { name: "開発担当との会話" })).toBeVisible();
  });

  test("キーボードで社員を選ぶ", async ({ page, browserName }) => {
    await page.goto("/office");
    const target = roomOf(page).getByRole("link", { name: /レビュー担当/ });
    await expect(target).toBeVisible();
    // Safari は既定で Tab がリンクに止まらず、Option+Tab で止まる
    const key = browserName === "webkit" ? "Alt+Tab" : "Tab";
    // 切り替えの並びを飛ばし、中身の頭から Tab で進む
    await page.getByRole("main").focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key);
      if (await target.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(target).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("log", { name: "レビュー担当との会話" })).toBeVisible();
  });
});

// 入れた管理の拡張の画面が 8 の画面の後ろに並ぶ (サービスと拡張の 3.8)
// ゲートウェイの返事は境目のモックで返し、画面が送る要求の中身を確かめる。ルートそのものは test/extensions/plug.test.ts で確かめる
const META = { traceId: "0".repeat(32) };

test.describe("8 の画面", () => {
  test("入れた拡張の画面", async ({ page }) => {
    let enabled = false;
    const toggles: unknown[] = [];
    const row = () => ({ id: "sample-notes", title: "メモ", enabled, ownerData: false });
    // 一覧は問い (?limit=100) を付けて読むので、パスで合わせる
    await page.route((url) => url.pathname === "/api/v1/extensions", (route) => route.fulfill({ json: { data: [row()], meta: { ...META, next: null } } }));
    await page.route("**/api/v1/extensions/sample-notes", async (route) => {
      toggles.push(route.request().postDataJSON());
      enabled = true;
      await route.fulfill({ json: { data: row(), meta: META } });
    });
    await page.route("**/api/v1/ext/sample-notes/note", (route) => route.fulfill({ json: { data: { body: "金曜は早く上がる" }, meta: META } }));

    await page.goto("/settings");
    await expect(page.getByRole("main").getByText("入れていない")).toBeVisible();
    await page.getByRole("button", { name: "メモを入れる" }).click();
    await expect(page.getByRole("main").getByText("入れている")).toBeVisible();
    expect(toggles).toEqual([{ enabled: true }]);

    // 左の切り替えか、狭い幅ではその他から、8 の画面の後ろの拡張の画面へ移る
    const side = page.getByRole("navigation").getByRole("link", { name: "メモ" });
    if (await side.isVisible()) {
      await side.click();
    } else {
      await page.getByRole("navigation").getByRole("link", { name: "その他" }).click();
      await page.getByRole("main").getByRole("link", { name: "メモ" }).click();
    }
    await expect(page.getByRole("heading", { level: 1, name: "メモ" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "メモ" })).toHaveValue("金曜は早く上がる");
  });
});
