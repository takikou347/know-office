// オーナーの承認の通し。社員が求めた承認を、ダッシュボードから入った承認を決める画面 (/approvals) で決め、決めた結果がほかの画面にも出る。ゲートウェイの返事は差し替えない (タスクとレビューの 3.1)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { addVirtualAuthenticator } from "../helpers/passkey.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";
import { part } from "./helpers/screen.ts";

const Approvals = z.object({ data: z.array(z.object({ id: z.string(), kind: z.string(), target: z.string(), reason: z.string().nullable() })) });

/**
 * 社員が求めた承認を 1 件置く。社員のツールの流れは Vitest で確かめるので、ここでは行を直に置く
 * @param kind 種類
 * @param target 対象
 * @param payload 中身
 * @returns 置いた承認の ID
 */
function request(kind: string, target: string, payload: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const body = JSON.stringify(payload).replaceAll("'", "''");
  seedMain(`INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES ('${id}', '${kind}', '${target}', '${body}', 'pending', 'president', ${String(Date.now())})`);
  return id;
}

/**
 * 前の通しが残した、決めていない承認を差し戻し扱いにし、開発担当の役を初期の値に戻す
 */
function clean(): void {
  seedMain("UPDATE approvals SET status = 'rejected', decided_at = 0, reason = '通しの片付け' WHERE status = 'pending'");
  seedMain("UPDATE staff SET role = '開発担当', boss_id = 'president' WHERE id = 'builder'");
}

/**
 * ダッシュボードの「承認を待つ物」の「すべて見る」から承認を決める画面に入り、1 件を探す
 * @param page 開くページ
 * @param title 承認の見出し
 * @returns その 1 件
 */
async function approvalItem(page: Page, title: string) {
  await page.goto("/");
  await part(page, "承認を待つ物").getByRole("link", { name: "すべて見る" }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByRole("heading", { level: 1, name: "承認" })).toBeVisible();
  const item = part(page, "承認を待つ物").getByRole("listitem").filter({ hasText: title });
  await expect(item).toBeVisible();
  return item;
}

/**
 * 1 件を承認か差し戻しに決める。理由を入れて決めるボタンを押す
 * @param page 開いているページ
 * @param item 決める 1 件
 * @param decision 承認か差し戻し
 * @param reason 理由
 */
async function decide(page: Page, item: ReturnType<Page["locator"]>, decision: "承認する" | "差し戻す", reason: string): Promise<void> {
  await item.getByRole("button", { name: decision }).click();
  const dialog = page.getByRole("dialog", { name: decision === "承認する" ? "承認しますか" : "差し戻しますか" });
  await dialog.getByLabel("理由").fill(reason);
  await dialog.getByRole("button", { name: decision, exact: true }).click();
}

test.beforeEach(() => {
  clean();
});

test.afterEach(() => {
  clean();
});

test.describe("組織図", () => {
  test("役の変更を承認すると、承認を待つ物から消え、組織図の役が変わる", async ({ page }) => {
    request("role_change", "builder", { target: "builder", role: "開発と運用の担当", bossId: "president", reason: "運用の直しも任せる" });
    const item = await approvalItem(page, "役の変更: 開発担当");
    await expect(item).toContainText("開発と運用の担当");
    await expect(item).toContainText("運用の直しも任せる");

    await decide(page, item, "承認する", "任せる");
    await expect(part(page, "承認を待つ物").getByText("「役の変更: 開発担当」を承認しました")).toBeVisible();
    await expect(part(page, "承認を待つ物").getByText("承認を待つ物は無い")).toBeVisible();

    // 社員の画面の組織図に、変わった役が出る
    await page.goto("/staff");
    await expect(page.getByRole("list", { name: "組織図" }).getByText("開発と運用の担当", { exact: true })).toBeVisible();
  });

  test("社員の追加は、承認しても社員が増えない事を出す", async ({ page }) => {
    request("staff_add", "デザイン担当", { role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" });
    const item = await approvalItem(page, "社員の追加: デザイン担当");
    await expect(item).toContainText("承認しても社員は増えません。足す時は社員の画面の「社員を追加」から足します");
    await decide(page, item, "承認する", "記録として認める");
    await expect(part(page, "承認を待つ物").getByText("承認を待つ物は無い")).toBeVisible();

    await page.goto("/staff");
    await expect(page.getByRole("list", { name: "組織図" }).getByText("社長", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "組織図" }).getByText("デザイン担当", { exact: true })).toHaveCount(0);
  });
});

test.describe("オーナーに上げる事", () => {
  test("費用の増える事はパスキーで確かめてから承認する", async ({ page }) => {
    await useOwnerPasskey(page);
    request("cost_increase", "Workers の有料プラン", { reason: "上限に届きそう" });
    const item = await approvalItem(page, "費用の増える事: Workers の有料プラン");
    await expect(item).toContainText("承認する前にパスキーで確かめます");
    await decide(page, item, "承認する", "今月は増やしてよい");
    await expect(part(page, "承認を待つ物").getByText("「費用の増える事: Workers の有料プラン」を承認しました")).toBeVisible();
    const approved = Approvals.parse(await (await page.request.get("/api/v1/approvals?status=approved")).json());
    expect(approved.data.find((a) => a.target === "Workers の有料プラン")?.reason).toBe("今月は増やしてよい");
  });

  test("パスキーで確かめられなければ、ダイアログは開いたままで、承認は待ったまま", async ({ page }) => {
    // オーナーのパスキーを持たない認証器にし、前の通しで確かめた期限も切る
    await addVirtualAuthenticator(page);
    seedMain("UPDATE sessions SET step_up_until = 0");
    request("cost_increase", "D1 の容量", { reason: "行が増えた" });
    const item = await approvalItem(page, "費用の増える事: D1 の容量");
    await decide(page, item, "承認する", "増やしてよい");
    const dialog = page.getByRole("dialog", { name: "承認しますか" });
    await expect(dialog.getByText("パスキーで確かめられませんでした")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "承認する", exact: true })).toBeEnabled();
    const pending = Approvals.parse(await (await page.request.get("/api/v1/approvals?status=pending")).json());
    expect(pending.data.find((a) => a.target === "D1 の容量")).toBeDefined();
  });

  test("新しい外部連携を差し戻すと、理由が残る", async ({ page }) => {
    // 前の通しが差し戻した同じ名前の承認と分けるため、名前を毎回変える
    const target = `Slack ${String(Date.now())}`;
    request("external_integration", target, { reason: "通知を Slack に送る" });
    const item = await approvalItem(page, `外部連携: ${target}`);
    await decide(page, item, "差し戻す", "今はつながない");
    await expect(part(page, "承認を待つ物").getByText(`「外部連携: ${target}」を差し戻しました`)).toBeVisible();
    const rejected = Approvals.parse(await (await page.request.get("/api/v1/approvals?status=rejected")).json());
    expect(rejected.data.find((a) => a.target === target)?.reason).toBe("今はつながない");
  });

  test("ほかの画面で決める種類は、決める画面へのリンクを出す", async ({ page }) => {
    const nodeId = crypto.randomUUID();
    request("merge", "example/know-office#12", { nodeId, reason: "main に入れる" });
    const item = await approvalItem(page, "main へのマージ: example/know-office#12");
    await expect(item.getByRole("button", { name: "承認する" })).toHaveCount(0);
    await expect(item.getByRole("link", { name: "社員と仕事のレビューで決める" })).toHaveAttribute("href", `/staff/president/tasks/${nodeId}`);
  });

  test("デプロイの承認は、決める所がまだ無い事を出し、リンクもボタンも出さない", async ({ page }) => {
    request("deploy", "knowidea-ui", { nodeId: crypto.randomUUID(), reason: "本番に出す" });
    const item = await approvalItem(page, "本番へのデプロイ: knowidea-ui");
    await expect(item).toContainText("デプロイの承認は、まだ決める所がありません");
    await expect(item.getByRole("link")).toHaveCount(0);
    await expect(item.getByRole("button")).toHaveCount(0);
  });

  test("1 件の道を開くとその承認だけを出し、理由が空なら送れない", async ({ page }) => {
    const id = request("external_integration", "Linear", { reason: "課題を Linear に移す" });
    request("cost_increase", "R2 の容量", { reason: "記録が増えた" });
    // ホームの「承認を待つ物」はその場で決めるカードで、1 件の道へは移らない。1 件の道は社員が承認を求めた時の通知 (approval_requested) の行き先なので、その道を直に開く
    await page.goto(`/approvals/${id}`);
    const list = part(page, "承認を待つ物").getByRole("listitem");
    await expect(list).toHaveCount(1);
    await expect(list).toContainText("外部連携: Linear");
    await list.getByRole("button", { name: "差し戻す" }).click();
    const dialog = page.getByRole("dialog", { name: "差し戻しますか" });
    await expect(dialog.getByRole("button", { name: "差し戻す", exact: true })).toBeDisabled();
    await dialog.getByLabel("理由").fill("   ");
    await expect(dialog.getByRole("button", { name: "差し戻す", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "やめる" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("ほかの所で先に決まっていたら、そう出して並びを読み直す", async ({ page }) => {
    const id = request("external_integration", "Notion", { reason: "議事を Notion に置く" });
    const item = await approvalItem(page, "外部連携: Notion");
    seedMain(`UPDATE approvals SET status = 'rejected', decided_at = ${String(Date.now())}, reason = 'ほかの端末で決めた' WHERE id = '${id}'`);
    await decide(page, item, "差し戻す", "後から決める");
    await expect(part(page, "承認を待つ物").getByText("「外部連携: Notion」はほかの所で先に決まっていました")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(part(page, "承認を待つ物").getByText("承認を待つ物は無い")).toBeVisible();
  });
});
