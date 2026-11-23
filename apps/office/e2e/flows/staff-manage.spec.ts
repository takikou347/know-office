// 社員を足し、設定を直し、削除する通し。オーナーが社員の画面の操作だけで行い、ゲートウェイの返事は差し替えない (タスクとレビューの 3.4)
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { readMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";

const Added = z.array(z.object({ id: z.string() }));

test("一覧の追加から社員を足し、設定を直し、削除する", async ({ page }) => {
  await useOwnerPasskey(page);
  const name = `通しの社員 ${String(Date.now() % 100_000)}`;
  // 落ちた時も足した社員を残さない。社員の画面の削除と同じルートで消す
  const removeLeft = async () => {
    for (const { id } of Added.parse(readMain(`SELECT id FROM staff WHERE role LIKE '通しの社員%' AND retired_at IS NULL`))) await page.request.delete(`/api/v1/staff/${id}`);
  };
  await settle(async () => {
    await page.goto("/staff");
    await page.getByRole("button", { name: "社員を追加" }).click();
    const dialog = page.getByRole("dialog", { name: "社員を追加" });
    await expect(dialog.getByText("Claude の費用とワークスペースの稼働が増えます")).toBeVisible();
    await dialog.getByLabel("名前").fill(name);
    await dialog.getByRole("combobox", { name: "モデル" }).click();
    await page.getByRole("option", { name: "Haiku 5.5" }).click();
    await dialog.getByRole("button", { name: "追加する" }).click();
    // 足すと一覧に出て、その社員の設定のタブが開く
    await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    await expect(page.getByRole("region", { name: `${name}の設定` })).toContainText("Haiku 5.5");
    // 組織図にも、社長の下に足した社員が出る
    await expect(page.getByRole("list", { name: "組織図" }).getByText(name, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "編集" }).click();
    await page.getByRole("main").getByLabel("名前").fill(`${name} 直した`);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("region", { name: `${name} 直したの設定` })).toBeVisible();

    await page.getByRole("button", { name: "社員を削除" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "削除する" }).click();
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
  }, [removeLeft]);
});
