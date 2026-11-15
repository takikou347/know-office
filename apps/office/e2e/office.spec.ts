import type { Page, Request } from "@playwright/test";
import { expect, test } from "./helpers/test.ts";
import { withoutWebgl } from "./helpers/webgl.ts";

// オフィスの 3D の部屋。社員を押すと会話に移り、ほかの画面では 3D を読まず、3D を出せない時は 2D の一覧に代え、
// 画面のデータの変わりを出来事として見せて読み上げる。画面の 3.4

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

/**
 * 部屋の区画を返す
 * @param page 見るページ
 * @returns 部屋の区画
 */
const roomOf = (page: Page) => page.getByRole("region", { name: "オフィスの部屋" });

/**
 * 読み込み直さずに、切り替えから画面へ移る。狭い幅で切り替えに無い画面は、その他から移る
 * @param page 見るページ
 * @param name 画面の名前
 */
async function openInApp(page: Page, name: string): Promise<void> {
  const side = page.locator("nav:visible").getByRole("link", { name, exact: true });
  if (await side.isVisible()) {
    await side.click();
  } else {
    await page.locator("nav:visible").getByRole("link", { name: "その他" }).click();
    await page.getByRole("main").getByRole("link", { name, exact: true }).click();
  }
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

/**
 * 部屋の canvas の今の絵を返す
 * @param page 見るページ
 * @returns 絵の PNG
 */
const pictureOf = (page: Page) => roomOf(page).locator("canvas").screenshot({ animations: "allow" });

/**
 * 社員を覆うリンクの箱の位置を返す
 * @param page 見るページ
 * @param name リンクの名前
 * @returns 左上の位置
 */
async function boxOf(page: Page, name: RegExp): Promise<{ x: number; y: number }> {
  const b = await roomOf(page).getByRole("link", { name }).boundingBox();
  return { x: Math.round(b?.x ?? -1), y: Math.round(b?.y ?? -1) };
}

test.describe("画面の一覧", () => {
  test("オフィスから会話に移る", async ({ page }) => {
    await page.goto("/office");
    const room = roomOf(page);
    await expect(room.locator("canvas")).toBeVisible();
    // 社員の姿を覆う所を押す
    await room.getByRole("link", { name: /作る役/ }).click();
    await expect(page).toHaveURL(/\/staff\/builder$/);
    await expect(page.getByRole("log", { name: "作る役との会話" })).toBeVisible();
  });
});

test.describe("速さ", () => {
  test("3D を読み込まない", async ({ page }) => {
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
  test("出来事を動きで見せる", async ({ page }) => {
    const waiting = page.getByRole("list", { name: "可を待つ物" }).getByRole("link", { name: /CodeEditor のページを足す/ });
    await page.goto("/");
    await expect(waiting).toBeVisible();
    await page.goto("/office");
    const room = roomOf(page);
    await expect(room.getByRole("link", { name: "社長 働いている" })).toBeVisible();
    await expect(room.getByRole("link", { name: "作る役 働いている" })).toBeVisible();
    await expect(room.getByRole("link", { name: "見る役 待っている" })).toBeVisible();
    await expect(room.getByRole("status")).toHaveText("直近の出来事はまだありません");

    // 可を出すと、タスクの一覧も同じ置き場から読むので変わり、オフィスでは承認の出来事になる
    await page.goto("/staff/builder/tasks/t2");
    await page.getByRole("button", { name: "可", exact: true }).click();
    await openInApp(page, "ダッシュボード");
    await expect(page.getByRole("list", { name: "可を待つ物" })).toBeVisible();
    await expect(waiting).toHaveCount(0);
    await openInApp(page, "オフィス");
    await expect(roomOf(page).getByRole("status")).toHaveText("直近の出来事: 見る役が「CodeEditor のページを足す」を承認した");

    // 不可を出すと、差し戻しの出来事になる。読み込み直すと置き場は初めの状態に戻るので、同じページで確かめる。
    // 別のページを開くと、GPU の無い headless では前のページの部屋も見えている扱いで描き続け、次の部屋を組むのが 5 秒を超える
    await page.goto("/staff/builder/tasks/t2");
    await page.getByRole("button", { name: "不可" }).click();
    await openInApp(page, "オフィス");
    await expect(roomOf(page).getByRole("status")).toHaveText("直近の出来事: 見る役が「CodeEditor のページを足す」を作る役に差し戻した");
  });

  test("WebGL が無い時は 2D の一覧", async ({ page }) => {
    await withoutWebgl(page);
    const urls = recordRequests(page);
    await page.goto("/office");
    const list = page.getByRole("list", { name: "社員の様子" });
    await expect(list.getByRole("link", { name: /作る役/ })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("直近の出来事はまだありません");
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(urls.filter((u) => /three/.test(u))).toEqual([]);
    await list.getByRole("link", { name: /作る役/ }).click();
    await expect(page.getByRole("log", { name: "作る役との会話" })).toBeVisible();
  });

  test("動きを減らす設定では動かさない", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/office");
    await expect(roomOf(page).locator("canvas")).toBeVisible();
    await expect(page.getByRole("list", { name: "社員の様子" })).toHaveCount(0);
    // 初めから動かさないので、止めるボタンは出さない
    await expect(page.getByRole("button", { name: "動きを止める" })).toHaveCount(0);
    const first = await boxOf(page, /見る役/);
    const before = await pictureOf(page);
    await page.waitForTimeout(600);
    expect(await boxOf(page, /見る役/)).toEqual(first);
    expect((await pictureOf(page)).equals(before)).toBe(true);
  });

  test("動きを止めるボタン", async ({ page }) => {
    await page.goto("/office");
    const halt = page.getByRole("button", { name: "動きを止める" });
    await expect(halt).toHaveAttribute("aria-pressed", "false");
    // 確かめ方が効いている事: 動いている間は、時間が経つと絵が変わる
    const moving = await pictureOf(page);
    await page.waitForTimeout(600);
    expect((await pictureOf(page)).equals(moving)).toBe(false);

    await halt.click();
    await expect(halt).toHaveAttribute("aria-pressed", "true");
    await expect(roomOf(page)).toHaveAttribute("data-motion", "still");
    const still = await pictureOf(page);
    await page.waitForTimeout(600);
    expect((await pictureOf(page)).equals(still)).toBe(true);

    await halt.click();
    await expect(halt).toHaveAttribute("aria-pressed", "false");
    await expect(roomOf(page)).toHaveAttribute("data-motion", "moving");
    await page.waitForTimeout(600);
    expect((await pictureOf(page)).equals(still)).toBe(false);
  });

  test("キーボードで社員を選ぶ", async ({ page, browserName }) => {
    await page.goto("/office");
    const target = roomOf(page).getByRole("link", { name: /見る役/ });
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
    await expect(page.getByRole("log", { name: "見る役との会話" })).toBeVisible();
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
