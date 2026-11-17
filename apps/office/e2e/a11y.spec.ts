import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/test.ts";
import { screens } from "../src/screen/routes.ts";
import { REVIEW_PATH, stubReview } from "./helpers/review.ts";
import { withGuardLearning } from "./helpers/guard.ts";
import { withoutWebgl } from "./helpers/webgl.ts";

// 使いやすさ: キーボードだけで承認まで出せ、8 画面と深い所に axe の critical と serious が無い。画面の全体の 3.3

const META = { traceId: "0".repeat(32) };

/**
 * 見本の拡張を入れた事にする。入口の返事は境目のモックで返す。入れ切りそのものは e2e/office.spec.ts と test/extensions/ で確かめる
 * @param page 開くページ
 */
async function withSampleNotes(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/v1/extensions",
    (route) => route.fulfill({ json: { data: [{ id: "sample-notes", title: "メモ", enabled: true, ownerData: false }], meta: { ...META, next: null } } }),
  );
  await page.route("**/api/v1/ext/sample-notes/note", (route) => route.fulfill({ json: { data: { body: "金曜は早く上がる" }, meta: META } }));
}

/** axe に掛ける所。8 画面に、その他と、社員とサービスを選んだ所と、入れた拡張の画面を足す */
const pages: readonly { name: string; path: string; heading: string; ready?: string; mock?: (page: Page) => Promise<void> }[] = [
  // オフィスは 3D の部屋と名札を読み終えてから掛ける
  ...screens.map((s) => ({ name: s.label, path: s.path, heading: s.label, ...(s.id === "office" ? { ready: "社員を押すと、その社員の会話が開きます" } : {}) })),
  // WebGL を出せないブラウザでは、オフィスは 2D の一覧に代わる
  { name: "オフィスの 2D の一覧", path: "/office", heading: "オフィス", ready: "社員を一覧で出しています", mock: withoutWebgl },
  // 動きを減らす設定では、オフィスは歩かずに置き換える部屋になる
  { name: "オフィスの動きを減らした部屋", path: "/office", heading: "オフィス", ready: "社員を押すと、その社員の会話が開きます", mock: (page) => page.emulateMedia({ reducedMotion: "reduce" }) },
  { name: "その他", path: "/more", heading: "その他" },
  { name: "社員の会話", path: "/staff/builder", heading: "社員と仕事" },
  { name: "社員の仕事の山", path: "/staff/builder?tab=tasks", heading: "社員と仕事" },
  // 勤怠は records.setup.ts が手元の D1 に置いた日を開き、表を読み終えてから掛ける
  { name: "社員の勤怠", path: "/staff/builder?tab=attendance&day=2026-11-13", heading: "社員と仕事", ready: "出勤 9:00" },
  // 入口にあるレビューは、境目のモックの返事で最初のファイルの変更を読み終えてから掛ける
  { name: "入口のレビュー", path: REVIEW_PATH, heading: "社員と仕事", ready: "const empty = 0;", mock: async (page) => void (await stubReview(page)) },
  // サービスの様子は、入口から読み終えてから掛ける
  { name: "サービスの様子", path: "/services/00000000-0000-7000-8000-000000000101", heading: "アイデアとサービス", ready: "公開した版" },
  // 木と組織図は records.setup.ts が手元の D1 に置いた物を、読み終えてから掛ける
  // 記録のサービスごとの内訳は、入口から読み終えてから掛ける
  { name: "記録のサービスごとの内訳", path: "/records", heading: "記録", ready: "CSV で出す" },
  { name: "目的と組織図の木", path: "/goals", heading: "目的と組織図", ready: "目標: know-office を動かし始める" },
  // 守りの効き目と蒸留した学びは、表を読み終えてから掛ける
  { name: "守りの効き目と蒸留した学び", path: "/guard", heading: "守り", ready: "入れる前の 7 日", mock: (page) => withGuardLearning(page) },
  // 入れた拡張の画面は、メモを読み終えてから掛ける
  { name: "入れた拡張の画面 (メモ)", path: "/ext/sample-notes", heading: "メモ", ready: "社員は note_read で読みます", mock: withSampleNotes },
];

/** focus がどの物にも無く、body にある時の訳 */
const BODY = "focus が body にある";

/** WCAG 2.2 AA までの決まり */
const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * 今 focus のある物に、目に見える輪があり、画面の中に見えているかを確かめる
 * @param page 確かめるページ
 * @returns 見えない時はその訳、見える時は null
 */
async function focusProblem(page: Page): Promise<string | null> {
  return page.evaluate(async (body) => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return body;
    // Safari は focus した物を画面に入れる送りを、次の描画の時に行う。送りの長さに頼らず、位置が 2 回続けて同じになるまで待つ
    let last = "";
    let still = false;
    for (let frame = 0; frame < 30 && !still; frame++) {
      await new Promise((done) => requestAnimationFrame(done));
      const box = el.getBoundingClientRect();
      const now = `${box.top},${box.left},${scrollX},${scrollY}`;
      still = now === last;
      last = now;
    }
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
    // 上と下に貼り付く帯の下に隠れていない (WCAG 2.2 の 2.4.11 は全部が隠れない事を求める)。Chrome は textarea に Tab で入ると
    // 入力の位置の行までしか寄せないので、画面に見えている所の真ん中で確かめる
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, innerHeight);
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, innerWidth);
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit && (el === hit || el.contains(hit)) ? null : `${name} が別の物に隠れている`;
  }, BODY);
}

/**
 * 今 focus のある物が、Tab で止まる物の最初か最後かを返す。tabindex を正の数にした物は無いので、DOM の順を Tab の順とする
 * @param page 確かめるページ
 * @returns 最初なら "first"、最後なら "last"、どちらでもなければ null
 */
async function tabEdge(page: Page): Promise<"first" | "last" | null> {
  return page.evaluate(() => {
    const selector = "a[href], button, input, select, textarea, summary, [tabindex]";
    const stops = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0,
    );
    const el = document.activeElement;
    if (el === stops[0]) return "first";
    if (el === stops.at(-1)) return "last";
    return null;
  });
}

/**
 * Tab だけで目当ての物まで進む。止まった所ごとに、focus の輪が見える事を確かめる
 * @param page 操作するページ
 * @param target 進む先
 * @param webkit Safari で動かしているか
 * @param max Tab を押す上限
 */
async function tabTo(page: Page, target: Locator, webkit: boolean, max = 60): Promise<void> {
  for (let n = 0; n < max; n++) {
    const edge = await tabEdge(page);
    await page.keyboard.press("Tab");
    const problem = await focusProblem(page);
    // Safari は最後の物から Tab を押すと focus をページの外 (アドレス欄など) へ出す。その時だけ許し、次の Tab で最初の物に戻る事を確かめる
    if (webkit && edge === "last" && problem === BODY) {
      await page.keyboard.press("Tab");
      expect(await tabEdge(page)).toBe("first");
      expect(await focusProblem(page)).toBeNull();
    } else {
      expect(problem).toBeNull();
    }
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab を ${max} 回押しても届かない: ${target.toString()}`);
}

test.describe("使いやすさ", () => {
  test("キーボードで操作する", async ({ page, browserName }) => {
    const webkit = browserName === "webkit";
    const h1 = (name: string) => page.getByRole("heading", { level: 1, name });
    const main = page.getByRole("main");
    await stubReview(page);
    await page.goto("/");
    await expect(h1("ダッシュボード")).toBeVisible();
    // ダッシュボードは入口から読んだ物を承認を待つ物の上に足すので、読み終えて形が落ち着いてから Tab で進む
    await expect(main.getByRole("heading", { name: "社員の様子" })).toBeVisible();
    await expect(main.getByText("承認を待つ物を読んでいます")).toHaveCount(0);

    // 切り替えから社員と仕事へ移る。今いる所に印が付く
    await tabTo(page, page.locator("nav:visible").getByRole("link", { name: "社員と仕事" }), webkit);
    await page.keyboard.press("Enter");
    await expect(h1("社員と仕事")).toBeVisible();
    await expect(page.locator('nav:visible [aria-current="page"]')).toHaveText(/社員と仕事/);

    // 社員を選び、仕事の山のタブを矢印で選ぶ。一覧は入口から読むので、読み終えてから Tab で進む
    await expect(main.getByRole("link", { name: /開発担当/ })).toBeVisible();
    await tabTo(page, main.getByRole("link", { name: /開発担当/ }), webkit);
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("tab", { name: "会話" }), webkit);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "仕事の山" })).toHaveAttribute("aria-selected", "true");
    expect(await focusProblem(page)).toBeNull();

    // 変更のある仕事を開き、承認を出す。仕事の山とレビューも読み終えてから進む
    await expect(page.getByRole("link", { name: /空の日の勤怠を 0 で出す/ })).toBeVisible();
    await tabTo(page, page.getByRole("link", { name: /空の日の勤怠を 0 で出す/ }), webkit);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "空の日の勤怠を 0 で出す" })).toBeVisible();
    await expect(page.getByRole("button", { name: "承認する" })).toBeVisible();
    // 最初のファイルの変更は後から読むので、読み終えて形が落ち着いてから進む
    await expect(page.getByText("const empty = 0;")).toBeVisible();
    await tabTo(page, page.getByRole("button", { name: "承認する" }), webkit);
    await page.keyboard.press("Enter");
    await expect(page.getByText("承認を出し、GitHub にも写しました")).toBeVisible();
  });

  test("通知の帯が後から出ても、focus した物を隠さない", async ({ page }) => {
    await stubReview(page);
    await page.goto(REVIEW_PATH);
    // 画面を開き終えるのと、後から読む最初のファイルの変更を分けて待つ。CI の最初の読み込みで 5 秒の 1 回に収まらない事がある
    await expect(page.getByRole("button", { name: "承認する" })).toBeVisible();
    await expect(page.getByText("const empty = 0;")).toBeVisible();
    // 中身の下の端にある入力欄に focus を置く。帯が後から出て中身の段が縮むと、下へ押し出される
    const comment = page.getByLabel("判断の一言");
    await comment.focus();
    await comment.evaluate((el) => el.scrollIntoView({ block: "end" }));
    expect(await focusProblem(page)).toBeNull();
    // 配信の印と同じく、タブが見えた時の読み直しで新しい未読の通知を受け、帯を後から出す。入口の返事は境目のモックで返し、長い中身で帯を何行にもする
    const notice = {
      id: "0193a000-0000-7000-8000-000000000001",
      at: new Date().toISOString(),
      level: "warn",
      kind: "e2e_band",
      title: "後から出た通知",
      body: "帯の高さを変える長い中身。".repeat(12),
      scope: "office",
      readAt: null,
      link: null,
    };
    await page.route(
      (url) => url.pathname === "/api/v1/notices",
      (route) => route.fulfill({ json: { data: [notice], meta: { ...META, next: null } } }),
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByText("後から出た通知")).toBeVisible();
    await expect.poll(() => focusProblem(page)).toBeNull();
  });

  test("Tab で入った物が中身の下の端で切れていても、全部を見える所へ寄せる", async ({ page }) => {
    await stubReview(page);
    await page.goto(REVIEW_PATH);
    await expect(page.getByText("const empty = 0;")).toBeVisible();
    const comment = page.getByLabel("判断の一言");
    // 1 つ前の物に focus を置き、入力欄の上の端だけが中身の段の下の端に見える所まで送る。ブラウザーは少しでも見えている物には Tab で送らない
    await comment.evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Shift+Tab");
    await comment.evaluate((el) => {
      const main = el.closest("main");
      if (!main) throw new Error("入力欄が main の中に無い");
      main.scrollTop += el.getBoundingClientRect().top - (main.getBoundingClientRect().bottom - 24);
    });
    await page.keyboard.press("Tab");
    await expect(comment).toBeFocused();
    await expect
      .poll(() =>
        comment.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const m = el.closest("main")?.getBoundingClientRect();
          // 送りの量は画素の整数に丸まり、中身の段の端は小数になるので、1 画素までの差は許す
          return m !== undefined && r.top >= m.top - 1 && r.bottom <= m.bottom + 1;
        }),
      )
      .toBe(true);
    expect(await focusProblem(page)).toBeNull();
  });

  // 1 ページに 2 秒ほど掛かり、14 ページを 1 つの test で回すと 5 秒を超えるので、ページごとに分ける
  test.describe("自動のチェック", () => {
    for (const p of pages) {
      test(p.name, async ({ page }) => {
        await p.mock?.(page);
        await page.goto(p.path);
        await expect(page.getByRole("heading", { level: 1, name: p.heading })).toBeVisible();
        if (p.ready) await expect(page.getByText(p.ready)).toBeVisible();
        const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
        const bad = violations
          .filter((v) => v.impact === "critical" || v.impact === "serious")
          .map((v) => ({ page: p.path, id: v.id, impact: v.impact, help: v.help, targets: v.nodes.map((n) => n.target.join(" ")) }));
        expect(bad).toEqual([]);
      });
    }
  });
});
