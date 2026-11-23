// 止めた記録をレビュー担当に聞く通し。設定の画面で開き、要るチェックが落ちたまま承認してタスクが止まると、レビュー担当のモデル (代わりの Claude API) が問題無しと返して再開し、止めた記録の経緯に出る。ゲートウェイの返事は差し替えない (自動停止の 3.5)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { FAKES } from "../helpers/fakes.ts";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { part, post } from "./helpers/screen.ts";
import { seedMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";

const NODE = "019a7b00-0000-7000-8000-0000000000e1";
const REVIEW = "019a7b00-0000-7000-8000-0000000000e2";
const PR = 11;
const HEAD = "f".repeat(40);
const REPO = "example/know-office";
const REASON = "チェックが落ちただけで、鍵や外への持ち出しは無い";

const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), target: z.string(), stopId: z.string() })) }) });
const Stops = z.object({ data: z.array(z.object({ id: z.string(), target: z.string(), resumedAt: z.string().nullable() }).loose()) });
const Requests = z.array(z.object({ model: z.string().optional(), tool_choice: z.object({ name: z.string() }).loose().optional() }).loose());

/**
 * 設定の画面で、止めた記録をレビュー担当に聞く事を開くか閉じる。開く時はパスキーで確かめる
 * @param page 画面を開くページ。開く時は useOwnerPasskey を付けておく
 * @param enabled 開くか
 */
async function setGuardReview(page: Page, enabled: boolean): Promise<void> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "止めた記録をレビュー担当に聞く", exact: true }) });
  const check = box.getByRole("checkbox", { name: "タスクか社員を止めたら、止めた記録をレビュー担当に読ませ、問題が無ければ再開する" });
  await expect(check).toBeVisible();
  if ((await check.isChecked()) === enabled) return;
  await check.click();
  await box.getByLabel("止めた記録をレビュー担当に聞くを変える理由").fill("レビュー担当の通し");
  await box.getByRole("button", { name: "止めた記録をレビュー担当に聞くを変える" }).click();
  await expect(box.getByText(/止めた記録をレビュー担当に聞くを変えました/)).toBeVisible();
}

/** 通しが置いた行を消す */
function clearSeed(): void {
  seedMain(`DELETE FROM reviews WHERE id = '${REVIEW}'; DELETE FROM nodes WHERE id = '${NODE}';`);
}

test.describe("再開", () => {
  test("レビュー担当が再開する", async ({ page }) => {
    // 設定を開く、承認する、答えを待つ、記録を開く、閉じ直すまでを 1 本で通すので、30 秒では足りない
    test.setTimeout(60_000);
    await useOwnerPasskey(page);
    await settle(
      async () => {
        await setGuardReview(page, true);
        await connectGitHub(page);
        clearSeed();
        seedMain(
          `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${NODE}', 'task', NULL, 'office', 'レビュー担当に聞く直し', NULL, 'build', 'builder', 'review', 1, 'president', 1, 1); ` +
            `INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, last_seen_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict) VALUES ('${REVIEW}', '${NODE}', '${REPO}', ${String(PR)}, 'ko/guard-review', '${"d".repeat(40)}', '${HEAD}', NULL, '[]', '直した', 'approve', NULL);`,
        );
        await fakeGitHubRoute(page, `GET /repos/${REPO}/pulls/${String(PR)}/files`, [{ filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }]);
        await fakeGitHubRoute(page, `GET /repos/${REPO}/contents/src/attendance.ts`, { type: "file", encoding: "base64", content: Buffer.from("const a = 2;\n").toString("base64") });
        await fakeGitHubRoute(page, `GET /repos/${REPO}/compare/main...${HEAD}`, { files: [{ filename: "src/attendance.ts", status: "modified" }] });
        // 要るチェックの 1 つが落ちているので、承認するとタスクが止まる
        await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }] });
        // レビュー担当のモデルの答えを、ゲートウェイの呼び出しにだけ積む
        const scripted = await page.request.post(`${FAKES}/anthropic/__fake/responses`, {
          data: { forGate: true, content: [{ type: "tool_use", id: "toolu_flow_review", name: "record_review", input: { resume: true, reason: REASON } }], stop_reason: "tool_use" },
        });
        expect(scripted.status()).toBe(204);
        const asked = async () => Requests.parse(await (await page.request.get(`${FAKES}/anthropic/__fake/requests`)).json()).filter((r) => r.tool_choice?.name === "record_review");
        const before = (await asked()).length;
        // 止めた記録は消えないので、前の通しが同じタスクに残した記録を除いて見る
        const stopsOf = async () => Stops.parse(await (await page.request.get("/api/v1/guard/stops")).json()).data.filter((s) => s.target === NODE);
        const old = new Set((await stopsOf()).map((s) => s.id));

        // 社員と仕事の画面からレビューを開き、オーナーが承認する
        const nav = page.getByRole("navigation", { name: "画面の切り替え" }).first();
        await nav.getByRole("link", { name: "社員" }).click();
        await page.getByRole("link", { name: /開発担当/ }).first().click();
        await page.getByRole("tab", { name: "仕事の山" }).click();
        await page.getByRole("link", { name: /レビュー担当に聞く直し/ }).click();
        await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
        await page.getByRole("button", { name: "承認する" }).click();

        // タスクを止めた後、返事の後にレビュー担当が答えて再開する
        const resumed = async () => (await stopsOf()).find((s) => !old.has(s.id))?.resumedAt ?? null;
        await expect.poll(resumed, { timeout: 15_000 }).not.toBeNull();
        // 再開でタスクが todo に戻って社員に配られないよう、すぐ済にする
        seedMain(`UPDATE nodes SET status = 'done' WHERE id = '${NODE}'`);
        const calls = (await asked()).slice(before);
        expect(calls.map((r) => r.model)).toEqual(["claude-opus-5-5"]);

        // セキュリティの画面の止めた記録に、レビュー担当の再開と理由が出る
        await nav.getByRole("link", { name: "ハーネス" }).click();
        await expect(part(page, "今止まっている物").getByRole("heading", { level: 3, name: `タスク ${NODE}` })).toHaveCount(0);
        // 一覧は新しい順なので、先頭が今の通しの記録
        const row = part(page, "止めた記録").getByRole("row").filter({ hasText: NODE }).first();
        await expect(row).toContainText("に再開した");
        await row.getByRole("button", { name: /の記録を開く/ }).click();
        const dialog = page.getByRole("dialog", { name: "止めた記録" });
        await expect(dialog.getByText(`レビュー担当: 再開した (${REASON})`, { exact: false })).toBeVisible();
      },
      [
        async () => {
          // 答えが来ずに止めたまま落ちた時は、オーナーが再開して後の通しに残さない
          seedMain(`UPDATE nodes SET status = 'done' WHERE id = '${NODE}'`);
          const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
          for (const s of state.data.stopped.filter((x) => x.scope === "task" && x.target === NODE)) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
        },
        () => setGuardReview(page, false),
        clearSeed,
        forgetGitHub,
      ],
    );
  });
});
