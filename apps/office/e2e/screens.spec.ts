import { expect, test } from "@playwright/test";

// 画面を足したら、ここに道を足す。どの幅でも横にはみ出さない事を確かめる
const screens = ["/"] as const;

for (const path of screens) {
  test(`${path} が開き、横にはみ出さない`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(path);
    await expect(page.getByRole("heading", { name: "know-office" })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("画面が手元の入口とつながる", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("入口とつながりました")).toBeVisible();
});
