// 利用場面の通しの後に、通しが出した通知を既読にし、入れ直した Claude の鍵を外す。残ると、次に流す通しのどの画面にも上部の帯が出て、起こし直した代わりの Claude API が鍵を断る
import { expect, test as teardown } from "../helpers/test.ts";
import { seedMain } from "./helpers/seed.ts";

teardown("通しが出した通知を既読にする", async ({ page }) => {
  await page.goto("/settings");
  // 入口の返事が画面に出るまで待つ。それより前はログインセッションがまだ無い。
  // 前の通しが落ちてパスキーの登録が流れなかった時も片付けるので、登録の有る無しのどちらでもよい
  await expect(page.getByRole("main").getByText(/^(?:登録済み|まだ登録していない)$/)).toBeVisible();
  const headers = { Origin: new URL(page.url()).origin };
  const res = await page.request.get("/api/v1/notices?limit=100");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  const notices = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : [];
  const unread = notices.flatMap((n: unknown) => (typeof n === "object" && n !== null && "id" in n && "readAt" in n && typeof n.id === "string" && n.readAt === null ? [n.id] : []));
  // 夜は通しのログインごとの通知が数十件溜まる。一度に送ると手元の D1 が塞がって 500 を返すので、1 件ずつ送る
  const failed: number[] = [];
  for (const id of unread) {
    const status = (await page.request.put(`/api/v1/notices/${id}/read`, { headers })).status();
    if (status >= 300) failed.push(status);
  }
  expect(failed).toEqual([]);

  await page.reload();
  await expect(page.getByRole("button", { name: "読んだ" })).toHaveCount(0);
});

teardown("通しが入れ直した Claude の鍵を外す", () => {
  // 代わりの Claude API は起こすたびに .dev.vars の鍵だけを通す。入れ直した鍵が vault に残ると、次の通しで社員の呼び出しが 401 で断られるので、環境変数の鍵に戻す
  seedMain("DELETE FROM vault WHERE name = 'claude_api_key'");
});
