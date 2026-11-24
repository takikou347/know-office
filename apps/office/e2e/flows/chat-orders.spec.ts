// 会話の言葉の指示の通し。設定の画面で開き、レビュー担当に「今日は休みにして」と話しかけると、発言の下に休みの指示が出て、会話から取り消せる。ゲートウェイの返事は差し替えない (社員と勤怠の 3.4)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { FAKES } from "../helpers/fakes.ts";
import { expect, test } from "../helpers/test.ts";
import { cancelLeftOrders } from "./helpers/seed.ts";
import { ownerPasskey } from "./helpers/staff.ts";
import { dropTodos, sayToReviewer } from "./helpers/staff-work.ts";
import { cancelCard, editCard, saveCard } from "./helpers/screen.ts";

/**
 * 設定の画面で会話の言葉の指示を開くか閉じる。開く時はパスキーで確かめる
 * @param page 画面を開くページ。開く時は ownerPasskey を付けておく
 * @param enabled 開くか
 */
async function setChatOrders(page: Page, enabled: boolean): Promise<void> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "会話の言葉の指示", exact: true }) });
  const check = box.getByRole("checkbox", { name: "話しかけた言葉から休み、早退、延長の指示を読み取る" });
  await editCard(box, "会話の言葉の指示");
  await expect(check).toBeVisible();
  if ((await check.isChecked()) === enabled) {
    await cancelCard(box, "会話の言葉の指示");
    return;
  }
  await check.click();
  await saveCard(box, "会話の言葉の指示", "会話の言葉の指示の通し");
  await expect(box.getByText(/会話の言葉の指示を変えました/)).toBeVisible();
}

/**
 * 代わりの Claude API に、ゲートウェイの抜き出しへの返事を積む。社員の SDK には渡さない
 * @param page 画面を開いたページ
 * @param orders tool の入力の orders
 */
async function scriptOrders(page: Page, orders: unknown[]): Promise<void> {
  const res = await page.request.post(`${FAKES}/anthropic/__fake/responses`, {
    data: { forGate: true, content: [{ type: "tool_use", id: "toolu_flow_orders", name: "record_orders", input: { orders } }], stop_reason: "tool_use" },
  });
  expect(res.status()).toBe(204);
}

/**
 * 今日の日本時間の日
 * @returns YYYY-MM-DD
 */
function today(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 明日の日本時間の日
 * @returns YYYY-MM-DD
 */
function tomorrow(): string {
  return new Date(Date.now() + 33 * 3_600_000).toISOString().slice(0, 10);
}

/** 指示の一覧の返事 */
const OrderList = z.object({ data: z.array(z.object({ id: z.string(), cancelledAt: z.string().nullable() }).loose()) });

/** 代わりの Claude API に届いた要求のうち、ゲートウェイの抜き出しの物 */
const Requests = z.array(z.object({ tool_choice: z.object({ name: z.string() }).loose().optional() }).loose());

/**
 * M/D の形の今日
 * @returns M/D
 */
function shortToday(): string {
  const [, m = "", d = ""] = today().split("-");
  return `${String(Number(m))}/${String(Number(d))}`;
}

// 手の空いたレビュー担当への発言はタスクになるので、通しの後に待ちの物を見送りにする
test.afterEach(async ({ page }) => {
  await dropTodos(page, "reviewer");
});

test.describe("オーナーの指示に合わせる", () => {
  test("会話の言葉で休みにする", async ({ page }) => {
    cancelLeftOrders("reviewer");
    await ownerPasskey(page);
    try {
      await setChatOrders(page, true);
      await scriptOrders(page, [{ kind: "off", day: today() }]);
      const bubble = await sayToReviewer(page, `今日は休みにして ${String(Date.now())}`);
      // 発言の下に休みの指示が出る
      await expect(bubble.getByText(`${shortToday()} を休みにしました`)).toBeVisible();
      // 指示の一覧にも会話から足した休みが出る
      await page.goto("/staff/reviewer?tab=attendance");
      // 前の通しが取り消した休みも並ぶので、取り消せる物だけを数える
      const activeOff = page.getByRole("list", { name: "レビュー担当への今日の指示" }).getByRole("button", { name: "休みの指示を取り消す" });
      await expect(activeOff).toHaveCount(1);
      // 会話から取り消す
      await page.goto("/staff/reviewer?tab=talk");
      await bubble.getByRole("button", { name: "休みの指示を取り消す" }).click();
      await expect(bubble.getByText(`${shortToday()} を休みにしました (取り消しました)`)).toBeVisible();
      await page.goto("/staff/reviewer?tab=attendance");
      await expect(activeOff).toHaveCount(0);
      // 先にほかの所で取り消された指示は、会話のボタンから取り消すと「もう取り消されています」と出す
      await scriptOrders(page, [{ kind: "off", day: tomorrow() }]);
      const next = await sayToReviewer(page, `明日は休みにして ${String(Date.now())}`);
      const button = next.getByRole("button", { name: "休みの指示を取り消す" });
      await expect(button).toBeVisible();
      // 押せる大きさは 44px 以上で、幅 390 でも横にはみ出さない
      expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(button).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 800 });
      const listed = OrderList.parse(await (await page.request.get(`/api/v1/staff/reviewer/orders?day=${tomorrow()}`)).json()).data;
      for (const o of listed.filter((x) => x.cancelledAt === null)) expect((await page.request.delete(`/api/v1/staff/reviewer/orders/${o.id}`, { headers: { Origin: new URL(page.url()).origin } })).status()).toBe(200);
      await button.click();
      await expect(next.getByRole("status")).toHaveText("もう取り消されています");
      await expect(next.getByText(/を休みにしました \(取り消しました\)/)).toBeVisible();
    } finally {
      try {
        await setChatOrders(page, false);
      } finally {
        cancelLeftOrders("reviewer");
      }
    }
  });

  test("会話の言葉の指示が閉じていれば抜き出さない", async ({ page }) => {
    cancelLeftOrders("reviewer");
    await setChatOrders(page, false);
    const extracted = async () => Requests.parse(await (await page.request.get(`${FAKES}/anthropic/__fake/requests`)).json()).filter((r) => r.tool_choice?.name === "record_orders").length;
    const before = await extracted();
    const said = `閉じた時の休み ${String(Date.now())}`;
    // 前の通しのタスクを社員がまだ持っていると、渡る道は次のタスクになる。道によらず、発言の返事が届いてから確かめる
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/staff/reviewer/messages"));
    const bubble = await sayToReviewer(page, `今日は休みにして ${said}`);
    expect((await answered).status()).toBe(201);
    await expect(bubble).toBeVisible();
    await expect(bubble.getByText("を休みにしました")).toHaveCount(0);
    // ゲートウェイは抜き出しのために Claude を呼ばない
    expect(await extracted()).toBe(before);
  });
});
