// 利用場面の通しの後に、通しが出した通知を既読にする。未読が残ると、次に流す通しのどの画面にも上部の帯が出る
import { expect, test as teardown } from "../helpers/test.ts";

teardown("通しが出した通知を既読にする", async ({ page }) => {
  await page.goto("/settings");
  // 入口の返事が画面に出るまで待つ。それより前はログインセッションがまだ無い
  await expect(page.getByRole("main").getByText("登録済み")).toBeVisible();
  const headers = { Origin: new URL(page.url()).origin, "Content-Type": "application/json" };
  const res = await page.request.get("/api/v1/notices?limit=100");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  const notices = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : [];
  const unread = notices.flatMap((n: unknown) => (typeof n === "object" && n !== null && "id" in n && "readAt" in n && typeof n.id === "string" && n.readAt === null ? [n.id] : []));
  const replies = await Promise.all(unread.map((id) => page.request.put(`/api/v1/notices/${id}/read`, { headers })));
  expect(replies.map((r) => r.status()).filter((s) => s >= 300)).toEqual([]);

  await page.reload();
  await expect(page.getByRole("button", { name: "読んだ" })).toHaveCount(0);
});
