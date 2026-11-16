import { expect, test } from "./helpers/test.ts";

// 配信で発言が届く速さ。2 つのページで同じ社員の会話を開き、片方で送った言葉が、読み直さずにもう片方へ 1 秒以内に出る。応答を差し替えない (社員と自動の 3.7、画面の速さ)
// 社員の発言はワークスペースから足すので画面からは作れない。足してから配る処理は社員とオーナーで同じ appendMessage で、社員の側は test/gate/messages.test.ts で確かめる

test.describe("速さ", () => {
  test("発言が届く速さ", async ({ page, context }) => {
    const opened = page.waitForEvent("websocket");
    await page.goto("/staff/president");
    const socket = await opened;
    const log = page.getByRole("log", { name: "社長との会話" });
    await expect(log).toBeVisible();
    // 配信の WebSocket がつながるまで待つ。つながる前の発言は、つながった時の読み直しで拾うので速さを測れない
    await expect.poll(() => socket.isClosed()).toBe(false);
    await page.waitForTimeout(300);

    const other = await context.newPage();
    await other.goto("/staff/president");
    const body = `配信で届く ${String(Date.now())}`;
    await other.getByLabel("社長への言葉").fill(body);
    await other.getByRole("button", { name: "送る" }).click();
    await expect(other.getByRole("log", { name: "社長との会話" }).getByText(body)).toBeVisible();
    await expect(log.getByText(body)).toBeVisible({ timeout: 1000 });
  });
});
