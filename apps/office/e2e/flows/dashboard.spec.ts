import { expect, test } from "../helpers/test.ts";
import { part } from "./helpers/screen.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { runLocalWrangler, seedMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";

// ホームと記録を、本物のゲートウェイの /dashboard、/approvals、/records/attendance、/records/costs、/records/uptime と 5 分ごとの Cron で通す。記録は勤怠を月の表で、稼働率とエラーログをエラーのタブで見る。承認待ちとタスクは種に置き、応答を差し替えない (API の records と settings)

const NODE = "019a7b00-0000-7000-8000-0000000000ea";
const APPROVAL = "019a7b00-0000-7000-8000-0000000000eb";

test.describe("ホーム", () => {
  test("承認を待つ物、今日のタスク、費用の推移、サービスの数値を入口から出し、承認をその場で決めて、今日のタスクを開く", async ({
    page,
  }) => {
    seedMain(
      `DELETE FROM approvals WHERE id = '${APPROVAL}'; DELETE FROM nodes WHERE id = '${NODE}';`,
    );
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${NODE}', 'task', NULL, 'office', 'Slack に通知を送る', NULL, 'build', 'builder', 'waiting_owner', 1, 'president', 1, 1); ` +
        `INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES ('${APPROVAL}', 'staff_add', 'デザイン担当', '{"role":"デザイン担当","bossId":"president","reason":"画面の直しが溜まっている"}', 'pending', 'president', 1);`,
    );
    const undo = () =>
      seedMain(
        `DELETE FROM approvals WHERE id = '${APPROVAL}'; DELETE FROM nodes WHERE id = '${NODE}';`,
      );
    await settle(async () => {
      await page.goto("/");
      const main = page.getByRole("main");
      // 入口の様子の文と社員のカードは出さない
      await expect(
        main.getByRole("heading", { level: 2, name: "今日のタスク" }),
      ).toBeVisible();
      await expect(main.getByText("入口とつながりました")).toHaveCount(0);
      await expect(
        main.getByRole("heading", { level: 2, name: "社員の様子" }),
      ).toHaveCount(0);
      await expect(main.getByText("今月の費用", { exact: true })).toBeVisible();
      await expect(part(page, "費用の推移")).toBeVisible();
      // マイグレーションが置く knowidea-ui は運用の段階なので、数値の表に出る
      await expect(
        part(page, "サービスの数値").getByRole("row", {
          name: /knowidea-ui.*運用/,
        }),
      ).toBeVisible();

      // 承認を待つ物はその場で決める
      const card = part(page, "承認を待つ物")
        .getByRole("listitem")
        .filter({ hasText: "社員の追加: デザイン担当" });
      await card.getByRole("button", { name: "差し戻す" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("理由").fill("今は 3 人で回す");
      await dialog
        .getByRole("button", { name: "差し戻す", exact: true })
        .click();
      await expect(
        part(page, "承認を待つ物").getByText(
          "「社員の追加: デザイン担当」を差し戻しました",
        ),
      ).toBeVisible();
      await expect(card).toHaveCount(0);

      const today = page.getByRole("list", { name: "今日のタスク" });
      await today.getByRole("link", { name: "Slack に通知を送る" }).click();
      await expect(page).toHaveURL(new RegExp(`/staff/builder/tasks/${NODE}$`));
      await expect(
        page.getByRole("heading", { level: 2, name: "Slack に通知を送る" }),
      ).toBeVisible();
    }, [undo]);
  });
});

test.describe("記録", () => {
  test("勤怠を月で見る", async ({ page }) => {
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    const [year = "", month = "", date = ""] = day.split("-");
    seedMain(
      `INSERT OR REPLACE INTO daily_totals (staff_id, day, clock_in, clock_out, worked_ms, extension_ms, call_ms, stopped_ms, waiting_ms, reasons) VALUES ('reviewer', '${day}', NULL, NULL, 5400000, 0, 0, 0, 0, '[]')`,
    );
    await page.goto("/records");
    // 開いた時は勤怠のタブで、今月を選んでいる
    await expect(page.getByRole("tab", { name: "勤怠" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("combobox", { name: "見る月" })).toContainText(`${year}年${String(Number(month))}月`);
    const table = page.getByRole("region", { name: "office 全体の勤怠" }).getByRole("table");
    // 列は社員の役の名前、行は日。今日の行のレビュー担当の列に働いた時間を出し、最後の行に月の合計を置く
    await expect(table.getByRole("columnheader", { name: "レビュー担当" })).toBeVisible();
    const row = table.getByRole("row", { name: new RegExp(`^${String(Number(month))}/${String(Number(date))} `) });
    await expect(row.getByText("1 時間 30 分")).toBeVisible();
    await expect(table.getByRole("row").last()).toContainText("合計");
  });

  test("費用を月ごとと累計で見る", async ({ page }) => {
    // 使った額の記録は追記だけで戻せないので足さず、前の通しが残した額のままホームと記録が同じ値を出す事を確かめる
    await page.goto("/");
    const home = page.getByRole("main").getByText("今月の費用").locator("..");
    await expect(home.getByText(/^\d+\.\d{2}$/)).toBeVisible();
    const monthTotal = await home.getByText(/^\d+\.\d{2}$/).innerText();
    await page.goto("/records?tab=cost");
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    const label = `${day.slice(0, 4)}年${String(Number(day.slice(5, 7)))}月`;
    const trend = part(page, "費用の推移と累計");
    // 選んだ月 (今月) の合計はホームの今月の費用と同じで、Claude API と Cloudflare に分ける
    const picked = trend.getByText(`${label}の費用`).locator("..");
    await expect(picked.getByText(monthTotal, { exact: true })).toBeVisible();
    await expect(picked.getByText(/Claude API \d+\.\d{2} ドル、Cloudflare \d+\.\d{2} ドル \(見込み\)/)).toBeVisible();
    await expect(trend.getByText("累計の費用")).toBeVisible();
    // グラフは 12 か月を並べ、選んだ月を押した状態にする
    const chart = trend.getByRole("group", { name: "月ごとの費用の推移" });
    await expect(chart.getByRole("button")).toHaveCount(12);
    await expect(chart.getByRole("button", { name: new RegExp(`^${label} `) })).toHaveAttribute("aria-pressed", "true");
    // 表は 12 か月を新しい月から並べ、今月の行の合計もホームと同じ
    const table = trend.getByRole("region", { name: "月ごとの費用" }).getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(13);
    await expect(table.getByRole("row").nth(1)).toContainText(label);
    await expect(table.getByRole("row").nth(1)).toContainText(`${monthTotal} ドル`);
    // CSV は同じ内訳を月ごとに出し、最後に累計の行を置く
    const csv = await page.request.get(await trend.getByRole("link", { name: "月ごとの費用を CSV で出す" }).getAttribute("href") ?? "");
    expect(csv.ok()).toBe(true);
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines[0]).toBe("month,claude_usd,cloudflare_usd,total_usd");
    expect(lines.at(-2)).toMatch(new RegExp(`^${day.slice(0, 7)},`));
    expect(lines.at(-1)).toMatch(/^total,/);
    // 内訳は選んだ月の社員ごとと、サービスごとの Claude API の費用
    await expect(part(page, "Claude API の費用の内訳").getByRole("region", { name: "社員ごとの費用" }).or(part(page, "Claude API の費用の内訳").getByRole("region", { name: "サービスごとの費用" }))).toBeVisible();
  });

  test("5 分ごとの確かめから出した今月の稼働率を出す", async ({ page }) => {
    await page.goto("/records?tab=errors");
    const uptime = part(page, "稼働率");
    // 確かめの行は追記だけで消せないので、前の通しが残した件数を読み、Cron の 1 回で 6 つの部分の分が増える事を確かめる
    const counted = uptime.getByText(/確かめた \d+ 件/);
    await expect(counted).toBeVisible();
    const before = Number(
      /確かめた (\d+) 件/.exec(await counted.innerText())?.[1],
    );
    // 入口は 5 分ごとの Cron。開発の入口は scheduled を /cdn-cgi/local/scheduled で呼べる
    const fired = await page.request.get(
      `/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`,
    );
    expect(fired.ok()).toBe(true);
    await expect(async () => {
      await page.reload();
      await expect(
        uptime.getByText(`確かめた ${String(before + 6)} 件`),
      ).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(uptime.getByText(/^\d+\.\d{2}$/)).toBeVisible();
    await expect(uptime.getByText(/目安 99\.9%/)).toBeVisible();
  });

  test("新しいエラーログを出し、その要求をパスキーで確かめてたどる", async ({
    page,
  }) => {
    await useOwnerPasskey(page);
    // エラーログは追記だけで消せないので、通しごとに別の ID と traceId で置く。一覧は ID の新しい順なので、今の時刻の UUID v7 のうちいちばん後の ID にし、前の通しが残したエラーより先に出す
    const now = Date.now();
    const ts = now.toString(16).padStart(12, "0");
    const id = `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7fff-bfff-ffffffffffff`;
    const traceId = `e2e0${now.toString(16).padStart(28, "0")}`.slice(0, 32);
    const year = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
    }).format(new Date(now));
    runLocalWrangler([
      "exec",
      "wrangler",
      "d1",
      "execute",
      `REC_${year}`,
      "--local",
      `--command=INSERT INTO error_events (id, at, source, level, code, message, route, status, fingerprint, trace_id) VALUES ('${id}', ${String(now)}, 'job', 'error', 'storage_check_failed', '通しで置いたエラー', NULL, NULL, '${"e".repeat(64)}', '${traceId}')`,
    ]);
    await page.goto("/records?tab=errors");
    const log = part(page, "エラーログ");
    await log
      .getByRole("row", { name: /通しで置いたエラー/ })
      .getByRole("link", { name: "storage_check_failed の要求をたどる" })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/records\\?trace=${traceId}$`));
    const trail = part(page, "要求をたどる");
    await trail
      .getByRole("button", { name: "パスキーで確かめて記録を開く" })
      .click();
    await expect(
      trail
        .getByRole("region", { name: "要求の記録" })
        .getByRole("row", {
          name: /エラー.*job の error storage_check_failed: 通しで置いたエラー/,
        }),
    ).toBeVisible();
  });
});
