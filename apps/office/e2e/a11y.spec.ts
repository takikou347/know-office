import { AxeBuilder } from "@axe-core/playwright";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { screens } from "../src/screen/routes.ts";

// 使いやすさ: キーボードだけで承認まで出せ、8 画面と深い所に axe の critical と serious が無い。画面の 3.5

/** axe に掛ける所。8 画面に、その他と、社員とサービスを選んだ所を足す */
const pages: readonly { name: string; path: string; heading: string }[] = [
  ...screens.map((s) => ({ name: s.label, path: s.path, heading: s.label })),
  { name: "その他", path: "/more", heading: "その他" },
  { name: "社員の会話", path: "/staff/maker", heading: "社員と仕事" },
  { name: "社員の仕事の山", path: "/staff/maker?tab=tasks", heading: "社員と仕事" },
  { name: "社員の勤怠", path: "/staff/maker?tab=attendance", heading: "社員と仕事" },
  { name: "変更のレビュー", path: "/staff/maker/tasks/t2", heading: "社員と仕事" },
  { name: "サービスの様子", path: "/services/knowidea-ui", heading: "アイデアとサービス" },
];

/** WCAG 2.2 AA までの決まり */
const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * 今 focus のある物に、目に見える輪があり、画面の中に見えているかを確かめる
 * @param page 確かめるページ
 * @returns 見えない時はその訳、見える時は null
 */
async function focusProblem(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return "focus が body にある";
    const name = `${el.tagName.toLowerCase()} 「${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}」`;
    // カードのように、中のリンクに focus があると外の枠に輪を出す物もあるので、親もたどる
    let ringed = false;
    for (let e: Element | null = el; e && e !== document.body && !ringed; e = e.parentElement) {
      const cs = getComputedStyle(e);
      ringed = (cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
    }
    if (!ringed) return `${name} に focus の輪が無い`;
    const r = el.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    if (!inView) return `${name} が画面の外にある`;
    // 上と下に貼り付く帯の下に隠れていない (WCAG 2.2 の 2.4.11)
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (el === hit || el.contains(hit)) ? null : `${name} が別の物に隠れている`;
  });
}

/**
 * Tab だけで目当ての物まで進む。止まった所ごとに、focus の輪が見える事を確かめる
 * @param page 操作するページ
 * @param target 進む先
 * @param max Tab を押す上限
 */
async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let n = 0; n < max; n++) {
    await page.keyboard.press("Tab");
    expect(await focusProblem(page)).toBeNull();
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab を ${max} 回押しても届かない: ${target.toString()}`);
}

test.describe("使いやすさ", () => {
  test("キーボードで操作する", async ({ page }) => {
    const h1 = (name: string) => page.getByRole("heading", { level: 1, name });
    const main = page.getByRole("main");
    await page.goto("/");
    await expect(h1("ダッシュボード")).toBeVisible();

    // 切り替えから社員と仕事へ移る。今いる所に印が付く
    await tabTo(page, page.locator("nav:visible").getByRole("link", { name: "社員と仕事" }));
    await page.keyboard.press("Enter");
    await expect(h1("社員と仕事")).toBeVisible();
    await expect(page.locator('nav:visible [aria-current="page"]')).toHaveText(/社員と仕事/);

    // 社員を選び、仕事の山のタブを矢印で選ぶ
    await tabTo(page, main.getByRole("link", { name: /作る役/ }));
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("tab", { name: "会話" }));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "仕事の山" })).toHaveAttribute("aria-selected", "true");
    expect(await focusProblem(page)).toBeNull();

    // 変更のある仕事を開き、可を出す
    await tabTo(page, page.getByRole("link", { name: /CodeEditor のページを足す/ }));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "CodeEditor のページを足す" })).toBeVisible();
    await tabTo(page, page.getByRole("button", { name: "可", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page.getByText("可を出しました")).toBeVisible();
  });

  for (const p of pages) {
    test(`自動のチェック (${p.name})`, async ({ page }) => {
      await page.goto(p.path);
      await expect(page.getByRole("heading", { level: 1, name: p.heading })).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
      const bad = violations
        .filter((v) => v.impact === "critical" || v.impact === "serious")
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.map((n) => n.target.join(" ")) }));
      expect(bad).toEqual([]);
    });
  }
});
