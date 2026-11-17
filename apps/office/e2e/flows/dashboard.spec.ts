import { expect, test } from "../helpers/test.ts";
import { part } from "./helpers/screen.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { runLocalWrangler, seedMain } from "./helpers/seed.ts";

// ダッシュボードと記録を、本物のゲートウェイの /dashboard、/approvals、/records/attendance、/records/uptime と 5 分ごとの Cron で通す。承認待ちとタスクは種に置き、応答を差し替えない (API の records と settings)

const NODE = "019a7b00-0000-7000-8000-0000000000ea";
const APPROVAL = "019a7b00-0000-7000-8000-0000000000eb";

test.describe("ダッシュボード", () => {
  test("社員、承認を待つ物、今日の仕事、今月の費用を入口から出し、承認の 1 件と今日のタスクを開く", async ({ page }) => {
    seedMain(`DELETE FROM approvals WHERE id = '${APPROVAL}'; DELETE FROM nodes WHERE id = '${NODE}';`);
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${NODE}', 'task', NULL, 'office', 'Slack に通知を送る', NULL, 'build', 'builder', 'waiting_owner', 1, 'president', 1, 1); ` +
        `INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES ('${APPROVAL}', 'external_integration', 'Slack', '{"nodeId":"${NODE}"}', 'pending', 'builder', 1);`,
    );
    await page.goto("/");
    const staff = page.getByRole("main").locator("section", { has: page.getByRole("heading", { level: 2, name: "社員の様子" }) });
    for (const role of ["社長", "開発担当", "レビュー担当"]) await expect(staff.getByText(role, { exact: true })).toBeVisible();
    await expect(page.getByText("今月の費用")).toBeVisible();
    const today = page.getByRole("list", { name: "今日の仕事" });
    await expect(today.getByText("Slack に通知を送る")).toBeVisible();
    // 承認を待つ物は承認の一覧から読み、承認を決める画面の 1 件へ移る
    await page.getByRole("list", { name: "承認を待つ物" }).getByRole("link", { name: /Slack/ }).click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${APPROVAL}$`));
    await page.goBack();
    await today.getByRole("link", { name: "Slack に通知を送る" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/builder/tasks/${NODE}$`));
    await expect(page.getByRole("heading", { level: 2, name: "Slack に通知を送る" })).toBeVisible();
  });
});

test.describe("記録", () => {
  test("office 全体の勤怠を、社員の役の名前で新しい日から出す", async ({ page }) => {
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    seedMain(
      `INSERT OR REPLACE INTO daily_totals (staff_id, day, clock_in, clock_out, worked_ms, extension_ms, call_ms, stopped_ms, waiting_ms, reasons) VALUES ('reviewer', '${day}', NULL, NULL, 5400000, 0, 0, 0, 0, '[]')`,
    );
    await page.goto("/records");
    const table = page.getByRole("region", { name: "office 全体の勤怠" }).getByRole("table");
    const row = table.getByRole("row", { name: new RegExp(`${day}.*レビュー担当`) });
    await expect(row).toBeVisible();
    await expect(row.getByText("1 時間 30 分")).toBeVisible();
  });

  test("5 分ごとの確かめから出した今月の稼働率を出す", async ({ page }) => {
    await page.goto("/records");
    const uptime = part(page, "稼働率");
    // 確かめの行は追記だけで消せないので、前の通しが残した件数を読み、Cron の 1 回で 6 つの部分の分が増える事を確かめる
    const counted = uptime.getByText(/確かめた \d+ 件/);
    await expect(counted).toBeVisible();
    const before = Number(/確かめた (\d+) 件/.exec(await counted.innerText())?.[1]);
    // 入口は 5 分ごとの Cron。開発の入口は scheduled を /cdn-cgi/local/scheduled で呼べる
    const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(fired.ok()).toBe(true);
    await expect(async () => {
      await page.reload();
      await expect(uptime.getByText(`確かめた ${String(before + 6)} 件`)).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(uptime.getByText(/^\d+\.\d{2}$/)).toBeVisible();
    await expect(uptime.getByText(/目安 99\.9%/)).toBeVisible();
  });

  test("新しいエラーログを出し、その要求をパスキーで確かめてたどる", async ({ page }) => {
    await useOwnerPasskey(page);
    // エラーログは追記だけで消せないので、通しごとに別の ID と traceId で置く。一覧は ID の新しい順なので、今の時刻の UUID v7 のうちいちばん後の ID にし、前の通しが残したエラーより先に出す
    const now = Date.now();
    const ts = now.toString(16).padStart(12, "0");
    const id = `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7fff-bfff-ffffffffffff`;
    const traceId = `e2e0${now.toString(16).padStart(28, "0")}`.slice(0, 32);
    const year = new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric" }).format(new Date(now));
    runLocalWrangler([
      "exec",
      "wrangler",
      "d1",
      "execute",
      `REC_${year}`,
      "--local",
      `--command=INSERT INTO error_events (id, at, source, level, code, message, route, status, fingerprint, trace_id) VALUES ('${id}', ${String(now)}, 'job', 'error', 'storage_check_failed', '通しで置いたエラー', NULL, NULL, '${"e".repeat(64)}', '${traceId}')`,
    ]);
    await page.goto("/records");
    const log = part(page, "エラーログ");
    await log.getByRole("row", { name: /通しで置いたエラー/ }).getByRole("link", { name: "storage_check_failed の要求をたどる" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/records\\?trace=${traceId}$`));
    const trail = part(page, "要求をたどる");
    await trail.getByRole("button", { name: "パスキーで確かめて記録を開く" }).click();
    await expect(trail.getByRole("region", { name: "要求の記録" }).getByRole("row", { name: /エラー.*job の error storage_check_failed: 通しで置いたエラー/ })).toBeVisible();
  });
});
