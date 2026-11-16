// セキュリティの画面の通し。オーナーが画面で止め、記録を開いて判定を付け、再開し、基準を変える。ゲートウェイの返事は差し替えない (自動停止の 3.8)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { part, post } from "./helpers/screen.ts";

const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), stopId: z.string() })) }) });
const Thresholds = z.object({ data: z.object({ version: z.number(), values: z.record(z.string(), z.number()) }) });

/**
 * セキュリティの画面を開き、前のテストが止めたままにした社員を再開してから読み直す
 * @param page 開くページ
 */
async function openGuard(page: Page): Promise<void> {
  await page.goto("/guard");
  // 開いた時は初めの通知を待つ間 (長くて 1 秒) 画面を描かず、その間は「読んでいます」が無いので、出てから読み終わりを待つ
  await expect(part(page, "止めている物").getByRole("heading", { level: 2 })).toBeVisible();
  await expect(part(page, "止めている物").getByRole("status")).toHaveCount(0);
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  const left = state.data.stopped.filter((s) => s.scope === "staff");
  for (const s of left) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
  if (left.length > 0) await page.reload();
  await expect(part(page, "止めている物").getByText("止めている物は無い")).toBeVisible();
}

/**
 * 手で止めるボタンで社員を止める。確認の画面で止まる範囲を見てから止める
 * @param page 開いているページ
 * @param name 社員の名前
 */
async function stopStaff(page: Page, name: string): Promise<void> {
  await part(page, "手で止める").getByRole("button", { name: `${name}を止める` }).click();
  const dialog = page.getByRole("dialog", { name: "社員を止めますか" });
  await expect(dialog.getByText("止まる範囲: 社員")).toBeVisible();
  await expect(dialog.getByText(`止まる社員: ${name}`)).toBeVisible();
  await expect(dialog.getByText(/止まるタスク: \d+ 件/)).toBeVisible();
  await dialog.getByRole("button", { name: "止める", exact: true }).click();
  await expect(part(page, "手で止める").getByText("社員を止めました")).toBeVisible();
}

test.describe("再開", () => {
  test("社員を手で止めると、止めている物と止めた記録に出て、再開すると止めている物から消える", async ({ page }) => {
    await openGuard(page);
    await stopStaff(page, "開発担当");

    const stopped = part(page, "止めている物");
    await expect(stopped.getByRole("heading", { level: 3, name: "開発担当" })).toBeVisible();
    await expect(stopped.getByText("社員を止めている。手で止めた")).toBeVisible();
    const first = part(page, "止めた記録").getByRole("row").nth(1);
    await expect(first).toContainText("開発担当");
    await expect(first).toContainText("手で止めた");
    await expect(first).toContainText("止めている");

    // 読み直しても止めたまま。画面の中の印でなく、ゲートウェイの今の状態から出している
    await page.reload();
    await expect(part(page, "止めている物").getByRole("heading", { level: 3, name: "開発担当" })).toBeVisible();

    await part(page, "止めている物").getByRole("button", { name: "開発担当を再開する" }).click();
    await expect(part(page, "止めている物").getByText(/開発担当を .+ に再開しました/)).toBeVisible();
    await expect(part(page, "止めている物").getByText("止めている物は無い")).toBeVisible();
    await expect(part(page, "止めた記録").getByRole("row").nth(1)).toContainText("に再開した");
  });

});

test.describe("止めた記録", () => {
  // 記録を開くと、シグナル、数えた値、基準のバージョン、直前の操作が出て、判定を付けると一覧と経緯に出る
  test("記録が残る", async ({ page }) => {
    await openGuard(page);
    await stopStaff(page, "レビュー担当");
    const first = part(page, "止めた記録").getByRole("row").nth(1);
    await expect(first).toContainText("レビュー担当");
    await expect(first).toContainText("まだ");

    await first.getByRole("button", { name: /レビュー担当の記録を開く/ }).click();
    const dialog = page.getByRole("dialog", { name: "止めた記録" });
    await expect(dialog.getByText("手で止めた")).toBeVisible();
    await expect(dialog.getByText(/数えた値 0、基準 0、基準のバージョン \d+/)).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "直前の操作 (0 件)" })).toBeVisible();
    await expect(dialog.getByText("再開も判定もまだ無い")).toBeVisible();

    await dialog.getByRole("radio", { name: "誤って止めた" }).check();
    await dialog.getByLabel("判定の理由").fill("通しの確かめで止めた");
    await dialog.getByRole("button", { name: "判定を付ける" }).click();
    await expect(dialog.getByText("判定を「誤って止めた」にしました")).toBeVisible();
    // 経緯に、付けた判定と理由が残る
    await expect(dialog.getByText(/オーナー: 判定: 誤って止めた \(通しの確かめで止めた\)/)).toBeVisible();
    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(part(page, "止めた記録").getByRole("row").nth(1)).toContainText("誤って止めた");

    await part(page, "止めている物").getByRole("button", { name: "レビュー担当を再開する" }).click();
    await expect(part(page, "止めている物").getByText("止めている物は無い")).toBeVisible();
  });
});

test.describe("通知と手で止めるボタン", () => {
  test("手で止める", async ({ page }) => {
    await openGuard(page);
    // 確認の画面で取り消すと止めない
    await part(page, "手で止める").getByRole("button", { name: "社長を止める" }).click();
    const dialog = page.getByRole("dialog", { name: "社員を止めますか" });
    await expect(dialog.getByText("止まる社員: 社長")).toBeVisible();
    await dialog.getByRole("button", { name: "取り消す" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(part(page, "止めている物").getByText("止めている物は無い")).toBeVisible();

    // 止まる範囲とタスクの数を確かめた後に止まる
    await stopStaff(page, "社長");
    await expect(part(page, "止めている物").getByRole("heading", { level: 3, name: "社長" })).toBeVisible();
    await part(page, "止めている物").getByRole("button", { name: "社長を再開する" }).click();
    await expect(part(page, "止めている物").getByText("止めている物は無い")).toBeVisible();
  });
});

test.describe("止める仕組みを守る", () => {
  test("基準の表は、ゲートウェイの今の基準を出す", async ({ page }) => {
    await page.goto("/guard");
    const basis = part(page, "基準");
    await expect(basis.getByRole("region", { name: "基準" })).toBeVisible();
    const now = Thresholds.parse(await (await page.request.get("/api/v1/guard/thresholds")).json()).data;
    await expect(basis.getByText(`基準のバージョン ${String(now.version)}`)).toBeVisible();
    // 18 項目を全部出す。時間は分、率は % に直す
    await expect(basis.getByRole("row")).toHaveCount(19);
    await expect(basis.getByRole("row", { name: /1 つのタスクの最長時間/ })).toContainText(`${String((now.values["taskMaxMs"] ?? 0) / 60_000)} 分`);
    await expect(basis.getByRole("row", { name: /近かったとする、基準に対する割合/ })).toContainText(`${String((now.values["nearBp"] ?? 0) / 100)} %`);
    await expect(basis.getByRole("row", { name: /タスクを止める、同じ失敗の続いた数/ })).toContainText(`${String(now.values["repeatedFailures"])} 回`);
  });

  test("基準を変えるとパスキーを求められ、確かめると新しい値と版が出る", async ({ page }) => {
    await useOwnerPasskey(page);
    await page.goto("/guard");
    const basis = part(page, "基準");
    await expect(basis.getByRole("region", { name: "基準" })).toBeVisible();
    const before = Thresholds.parse(await (await page.request.get("/api/v1/guard/thresholds")).json()).data;
    const was = before.values["repeatedFailures"] ?? 0;
    const next = was + 1;

    /**
     * 同じ失敗の続いた数を変える
     * @param value 新しい値
     * @param reason 理由
     */
    const change = async (value: number, reason: string) => {
      await basis.getByRole("button", { name: "タスクを止める、同じ失敗の続いた数を変える" }).click();
      const dialog = page.getByRole("dialog", { name: "基準を変える" });
      await dialog.getByLabel("新しい値 (回)").fill(String(value));
      await dialog.getByLabel("変える理由").fill(reason);
      await dialog.getByRole("button", { name: "変える" }).click();
    };

    // 1 度目はパスキーの確認が無いので断られ、画面がパスキーで確かめてから 1 度だけ送り直す
    const refused = page.waitForResponse((r) => r.url().endsWith("/api/v1/guard/thresholds") && r.request().method() === "PUT" && r.status() === 401);
    const confirmed = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/step-up") && r.status() === 200);
    await change(next, "通しの確かめで上げる");
    await refused;
    await confirmed;
    await expect(basis.getByText(`タスクを止める、同じ失敗の続いた数を ${String(next)} 回 に変えました (バージョン ${String(before.version + 1)})`)).toBeVisible();
    await expect(basis.getByText(`基準のバージョン ${String(before.version + 1)}`)).toBeVisible();
    await expect(basis.getByRole("row", { name: /タスクを止める、同じ失敗の続いた数/ })).toContainText(`${String(next)} 回`);

    // 読み直しても新しい値のまま
    await page.reload();
    await expect(part(page, "基準").getByRole("row", { name: /タスクを止める、同じ失敗の続いた数/ })).toContainText(`${String(next)} 回`);

    // 確認は 15 分有効なので、元の値へ戻す時はパスキーを求められない
    await change(was, "通しの確かめの後に戻す");
    await expect(basis.getByText(`基準のバージョン ${String(before.version + 2)}`)).toBeVisible();
    await expect(basis.getByRole("row", { name: /タスクを止める、同じ失敗の続いた数/ })).toContainText(`${String(was)} 回`);
  });
});
