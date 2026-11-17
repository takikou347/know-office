// 会話の言葉の指示の通し。設定の画面で開き、レビュー担当に「今日は休みにして」と話しかけると、発言の下に休みの指示が出て、会話から取り消せる。ゲートウェイの返事は差し替えない (社員と勤怠の 3.4)
import type { Page } from "@playwright/test";
import { FAKES } from "../helpers/fakes.ts";
import { expect, test } from "../helpers/test.ts";
import { cancelLeftOrders } from "./helpers/seed.ts";
import { ownerPasskey, sayToReviewer } from "./helpers/staff-work.ts";

/**
 * 設定の画面で会話の言葉の指示を開くか閉じる。開く時はパスキーで確かめる
 * @param page 画面を開くページ。開く時は ownerPasskey を付けておく
 * @param enabled 開くか
 */
async function setChatOrders(page: Page, enabled: boolean): Promise<void> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "会話の言葉の指示", exact: true }) });
  const check = box.getByRole("checkbox", { name: "話しかけた言葉から休み、早退、延長の指示を読み取る" });
  await expect(check).toBeVisible();
  if ((await check.isChecked()) === enabled) return;
  await check.click();
  await box.getByLabel("会話の言葉の指示を変える理由").fill("会話の言葉の指示の通し");
  await box.getByRole("button", { name: "会話の言葉の指示を変える" }).click();
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
 * M/D の形の今日
 * @returns M/D
 */
function shortToday(): string {
  const [, m = "", d = ""] = today().split("-");
  return `${String(Number(m))}/${String(Number(d))}`;
}

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
      await page.goto("/staff/reviewer");
      await expect(page.getByRole("list", { name: "レビュー担当への今日の指示" }).getByText("休み", { exact: true })).toBeVisible();
      // 会話から取り消す
      await page.goto("/staff/reviewer?tab=talk");
      await bubble.getByRole("button", { name: "休みの指示を取り消す" }).click();
      await expect(bubble.getByText(`${shortToday()} を休みにしました (取り消しました)`)).toBeVisible();
      await page.goto("/staff/reviewer");
      await expect(page.getByRole("list", { name: "レビュー担当への今日の指示" }).getByText(/に取り消した/)).toBeVisible();
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
    const extracted = async () => (await (await page.request.get(`${FAKES}/anthropic/__fake/requests`)).text()).split('"name":"record_orders"').length;
    const before = await extracted();
    const said = `閉じた時の休み ${String(Date.now())}`;
    const bubble = await sayToReviewer(page, `今日は休みにして ${said}`);
    await expect(bubble.getByText("次のタスクで渡します").or(bubble.getByText("社員に渡しました"))).toBeVisible();
    await expect(bubble.getByText("を休みにしました")).toHaveCount(0);
    // ゲートウェイは抜き出しのために Claude を呼ばない
    expect(await extracted()).toBe(before);
  });
});
