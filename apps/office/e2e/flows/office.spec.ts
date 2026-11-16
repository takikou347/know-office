import { expect, test } from "@playwright/test";
import { connectGitHub, fakeGitHubRoute } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";

// オフィスの部屋が、本物のゲートウェイのレビューの判断を出来事として見せる。GitHub は手元の代わりにつなぎ、プルリクエストの変更だけを置く (画面の 3.4)
// TODO(#87): 出来事をサーバーで作って配信で送るようになったら、画面の中の橋でなく配信で届いた出来事を見る

const NODE = "019a7b00-0000-7000-8000-0000000000e7";
const REVIEW = "019a7b00-0000-7000-8000-0000000000e8";
const PR = 7;
const HEAD = "c".repeat(40);

test.describe("オフィスの部屋", () => {
  test("出来事を動きで見せる", async ({ page }) => {
    await page.goto("/settings");
    await useOwnerPasskey(page);
    await connectGitHub(page);
    seedMain(`DELETE FROM reviews WHERE id = '${REVIEW}'; DELETE FROM nodes WHERE id = '${NODE}';`);
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${NODE}', 'task', NULL, 'office', '勤怠の表を足す', NULL, 'build', 'builder', 'review', 1, 'president', 1, 1); ` +
        `INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, last_seen_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict) VALUES ('${REVIEW}', '${NODE}', 'example/know-office', ${String(PR)}, 'ko/attendance-table', '${"d".repeat(40)}', '${HEAD}', NULL, '[]', '表にした', 'approve', NULL);`,
    );
    await fakeGitHubRoute(page, `GET /repos/example/know-office/pulls/${String(PR)}/files`, [{ filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }]);
    await fakeGitHubRoute(page, "GET /repos/example/know-office/contents/src/attendance.ts", { type: "file", encoding: "base64", content: Buffer.from("const a = 2;\n").toString("base64") });

    // 部屋を 1 度開き、今の様子を受け取った事にする
    const nav = page.getByRole("navigation", { name: "画面の切り替え" }).first();
    await nav.getByRole("link", { name: "オフィス" }).click();
    const room = page.getByRole("region", { name: "オフィスの部屋" });
    await expect(room.getByRole("status")).toHaveText("直近の出来事はまだありません");

    // 本物のレビューを開いて差し戻すと、オフィスでは差し戻しの出来事になる
    await nav.getByRole("link", { name: "社員と仕事" }).click();
    await page.getByRole("link", { name: /開発担当/ }).first().click();
    await page.getByRole("tab", { name: "仕事の山" }).click();
    await page.getByRole("link", { name: /勤怠の表を足す/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
    await page.getByRole("button", { name: "差し戻す" }).click();
    await expect(page.getByText("差し戻し、作る役に戻しました")).toBeVisible();
    await nav.getByRole("link", { name: "オフィス" }).click();
    await expect(room.getByRole("status")).toHaveText(/「勤怠の表を足す」を.*差し戻した/);
  });
});
