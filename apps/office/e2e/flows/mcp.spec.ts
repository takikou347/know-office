// MCP の連携の通し。オーナーが設定の画面で鍵を作り、外の AI がその鍵で社員を読み、画面で切ると通らなくなる。ゲートウェイの返事は差し替えない (ログインと記録の 3.10)
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { part } from "./helpers/screen.ts";

/**
 * 外の AI として MCP の入口で道具を呼ぶ。開発環境の Access の代わりが証明を付ける
 * @param request Playwright の要求の口
 * @param token MCP の連携の鍵
 * @returns 返事のステータスと本文
 */
async function listStaff(request: APIRequestContext, token: string): Promise<{ status: number; text: string }> {
  const res = await request.post("/api/v1/mcp", {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_staff", arguments: {} } },
  });
  return { status: res.status(), text: await res.text() };
}

test.describe("外の AI から MCP で操作する", () => {
  test("MCP の鍵を作って切る", async ({ page }) => {
    await useOwnerPasskey(page);
    await page.goto("/settings");
    const box = part(page, "MCP の連携");
    const name = `通しの AI ${String(Date.now())}`;
    await box.getByLabel("つなぐ先の名前").fill(name);
    await box.getByRole("radio", { name: "読むだけ" }).click();
    await box.getByRole("button", { name: "MCP の連携を作る" }).click();
    const token = (await box.getByRole("region", { name: "MCP の連携の鍵" }).or(box.locator("pre")).first().innerText()).trim();
    expect(token).toMatch(/^ko_mcp_/);
    await expect(box.getByText(`${name} (読むだけ)`)).toBeVisible();

    const read = await listStaff(page.request, token);
    expect(read.status).toBe(200);
    expect(read.text).toContain("builder");

    await box.getByRole("button", { name: `${name}の MCP の連携を切る` }).click();
    await expect(box.getByText(`${name}の連携を切りました`)).toBeVisible();
    expect((await listStaff(page.request, token)).status).toBe(401);
  });
});
