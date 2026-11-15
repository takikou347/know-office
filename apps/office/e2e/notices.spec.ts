import { expect, test } from "./helpers/test.ts";

// 通知が画面の上部の帯とダッシュボードに出て、読んだら帯から消える (サービスと拡張の 3.5)
// 通知の一覧は境目のモックで返し、画面が送る既読の要求を確かめる。ルートそのものは test/monitoring/notices.test.ts で確かめる
const NOTICE = {
  id: "0190f4a8-0000-7000-8000-000000000301",
  at: "2026-12-08T00:00:00.000Z",
  level: "warn",
  kind: "claude_failing",
  title: "Claude の API の失敗が続いている",
  body: "5 分に 3 回失敗した。最後は 500",
  scope: "office",
  readAt: null,
};
const META = { traceId: "0".repeat(32), next: null };

test("通知が上部の帯とダッシュボードに出て、読んだら帯から消える", async ({ page }) => {
  const reads: string[] = [];
  await page.route("**/api/v1/notices**", async (route) => {
    await route.fulfill({ json: { data: [{ ...NOTICE, readAt: reads.length > 0 ? "2026-12-08T00:05:00.000Z" : null }], meta: META } });
  });
  await page.route("**/api/v1/notices/*/read", async (route) => {
    reads.push(route.request().url());
    await route.fulfill({ status: 204 });
  });

  await page.goto("/");
  const bar = page.getByRole("status").filter({ hasText: NOTICE.title });
  await expect(bar).toBeVisible();
  await expect(bar.getByText(NOTICE.body)).toBeVisible();
  const list = page.getByRole("list", { name: "お知らせ" });
  await expect(list.getByText(NOTICE.title)).toBeVisible();
  await expect(list.getByText("9:00")).toBeVisible();

  await bar.getByRole("button", { name: "読んだ" }).click();
  await expect(bar).toBeHidden();
  expect(reads).toEqual([expect.stringContaining(`/api/v1/notices/${NOTICE.id}/read`)]);
  // 一覧には読んだ通知も残る
  await expect(list.getByText(NOTICE.title)).toBeVisible();
});

test("開いた後に通知が届いても、中身の位置がずれない", async ({ page }) => {
  // 通知の答えを遅らせ、画面の中身が先に出てから帯が差し込まれる並びを起こす (CI の Safari で押す物がずれた並び)
  await page.route("**/api/v1/notices**", async (route) => {
    await new Promise((done) => setTimeout(done, 400));
    await route.fulfill({ json: { data: [NOTICE], meta: META } });
  });

  await page.goto("/");
  const heading = page.getByRole("main").getByRole("heading", { name: "社員の様子" });
  await expect(heading).toBeVisible();
  const before = await heading.boundingBox();
  await expect(page.getByRole("status").filter({ hasText: NOTICE.title })).toBeVisible();
  expect(await heading.boundingBox()).toEqual(before);
});

test("通知が読めない間も、少し待てば中身が出る", async ({ page }) => {
  // 通知の答えが返らなくても、中身を隠し続けない
  await page.route("**/api/v1/notices**", () => new Promise(() => {}));

  await page.goto("/");
  await expect(page.getByRole("main").getByRole("heading", { name: "社員の様子" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: NOTICE.title })).toHaveCount(0);
});
