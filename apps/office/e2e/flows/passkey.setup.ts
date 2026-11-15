// 利用場面の通しの前に、設定の画面でオーナーの最初のパスキーを登録する。大事な操作の前の確認は、どの通しもこの 1 本で通す
import { expect, test as setup } from "../helpers/test.ts";
import { addVirtualAuthenticator } from "../helpers/passkey.ts";
import { storePasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";

setup.describe("大事な操作の前にパスキーで確かめる", () => {
  setup("設定の画面で最初のパスキーを登録すると、登録済みと出る", async ({ page }) => {
    // 前に流した通しのパスキーは、鍵を持つ認証器がもう無いので消す。最初の 1 本だけが確認無しで登録できる
    seedMain("DELETE FROM passkeys");
    const authenticator = await addVirtualAuthenticator(page);
    await page.goto("/settings");
    const main = page.getByRole("main");
    await expect(main.getByText("まだ登録していない")).toBeVisible();

    await main.getByRole("button", { name: "パスキーを登録する" }).click();
    await expect(main.getByText("パスキーを登録しました")).toBeVisible();
    await expect(main.getByText("登録済み")).toBeVisible();
    await expect(main.getByRole("button", { name: "パスキーを登録する" })).toHaveCount(0);

    // 読み直しても登録済みのまま
    await page.reload();
    await expect(page.getByRole("main").getByText("登録済み")).toBeVisible();
    const [credential] = await authenticator.credentials();
    expect(credential).toBeDefined();
    if (credential) storePasskey(credential);
  });
});
