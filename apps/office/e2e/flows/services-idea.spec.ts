// アイデアとサービスの画面で、名前と一言で足した案を段階のフィルターで探し、元の案を選ぶ欄で直す通し。ゲートウェイの返事は差し替えない (サービスと拡張の 3.1)
import { expect, test } from "../helpers/test.ts";
import { restoreSeedServices } from "./helpers/seed.ts";
import { addIdea, choose } from "./helpers/services.ts";

test.afterEach(() => {
  restoreSeedServices();
});

test.describe("アイデアから運用までの流れ", () => {
  test("案を足して直す", async ({ page }) => {
    const title = `直す案 ${crypto.randomUUID().slice(0, 8)}`;
    await addIdea(page, title);
    const main = page.getByRole("main");
    // 段階のフィルターで、足した案がアイデアに出て、検討には出ない
    await choose(page, "段階", "アイデア");
    await expect(main.getByRole("link", { name: title })).toBeVisible();
    await choose(page, "段階", "検討");
    await expect(main.getByRole("link", { name: title })).toHaveCount(0);
    await choose(page, "段階", "すべて");

    // 編集を押すとその場で選ぶ欄になり、保存で入る。やめると元に戻る
    await main.getByRole("tab", { name: "元の案" }).click();
    await main.getByRole("button", { name: "編集" }).click();
    await choose(page, "種類", "コンテンツ");
    await main.getByRole("button", { name: "やめる" }).click();
    await expect(main.getByRole("combobox", { name: "種類" })).toHaveCount(0);
    await main.getByRole("button", { name: "編集" }).click();
    await choose(page, "種類", "コンテンツ");
    await choose(page, "使う人", "個人の利用者");
    await choose(page, "月の費用の見込み", "5 ドル");
    await choose(page, "月の売り上げの見込み", "100 ドル");
    await main.getByRole("button", { name: "保存" }).click();
    await expect(main.getByText("元の案を保存しました")).toBeVisible();
    const idea = main.getByRole("tabpanel", { name: "元の案" });
    await expect(idea.getByText("個人の利用者")).toBeVisible();
    await expect(idea.getByText("5.00 ドル")).toBeVisible();
    await expect(idea.getByText("100.00 ドル")).toBeVisible();
    // 見出しの種類の印と一覧の行も変わる
    await expect(main.getByText("コンテンツ", { exact: true }).first()).toBeVisible();
    await page.reload();
    await main.getByRole("tab", { name: "元の案" }).click();
    await expect(main.getByRole("tabpanel", { name: "元の案" }).getByText("個人の利用者")).toBeVisible();
  });
});
