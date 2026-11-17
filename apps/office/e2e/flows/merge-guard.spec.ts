// 要るチェックが落ちたままのプルリクエストをオーナーが承認すると、main に入れずにそのタスクを止め、セキュリティの画面の止めている物に出る。GitHub は手元の代わりにつなぎ、チェックの結果だけを置く (タスクとレビューの 3.1、自動停止の 1 章)
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { connectGitHub, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { post } from "./helpers/screen.ts";
import { seedMain } from "./helpers/seed.ts";

const NODE = "019a7b00-0000-7000-8000-0000000000f1";
const REVIEW = "019a7b00-0000-7000-8000-0000000000f2";
const PR = 9;
const HEAD = "e".repeat(40);
const REPO = "example/know-office";

const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), target: z.string(), stopId: z.string() })) }) });
const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });

/** 通しが置いた行を消す */
function clearSeed(): void {
  seedMain(`DELETE FROM reviews WHERE id = '${REVIEW}'; DELETE FROM nodes WHERE id = '${NODE}';`);
}

test.describe("チェックが落ちたままのマージ", () => {
  test.afterEach(async ({ page }) => {
    // 止めたタスクを再開してから、置いた行と GitHub の連携を消す。後の通しは止めた物の無い前提で流れる
    const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
    for (const s of state.data.stopped.filter((x) => x.scope === "task" && x.target === NODE)) await post(page, `/api/v1/guard/stops/${s.stopId}/resume`);
    clearSeed();
    forgetGitHub();
  });

  test("要るチェックが落ちたまま承認すると、main に入れずにタスクを止め、止めている物に出る", async ({ page }) => {
    await page.goto("/settings");
    await useOwnerPasskey(page);
    await connectGitHub(page);
    clearSeed();
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${NODE}', 'task', NULL, 'office', 'チェックの落ちた直し', NULL, 'build', 'builder', 'review', 1, 'president', 1, 1); ` +
        `INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, last_seen_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict) VALUES ('${REVIEW}', '${NODE}', '${REPO}', ${String(PR)}, 'ko/failed-checks', '${"d".repeat(40)}', '${HEAD}', NULL, '[]', '直した', 'approve', NULL);`,
    );
    await fakeGitHubRoute(page, `GET /repos/${REPO}/pulls/${String(PR)}/files`, [{ filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }]);
    await fakeGitHubRoute(page, `GET /repos/${REPO}/contents/src/attendance.ts`, { type: "file", encoding: "base64", content: Buffer.from("const a = 2;\n").toString("base64") });
    await fakeGitHubRoute(page, `GET /repos/${REPO}/compare/main...${HEAD}`, { files: [{ filename: "src/attendance.ts", status: "modified" }] });
    // 要るチェックの 1 つが落ちている
    await fakeGitHubRoute(page, `GET /repos/${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }] });

    // 社員と仕事の画面からレビューを開き、オーナーが承認する
    const nav = page.getByRole("navigation", { name: "画面の切り替え" }).first();
    await nav.getByRole("link", { name: "社員と仕事" }).click();
    await page.getByRole("link", { name: /開発担当/ }).first().click();
    await page.getByRole("tab", { name: "仕事の山" }).click();
    await page.getByRole("link", { name: /チェックの落ちた直し/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
    await page.getByRole("button", { name: "承認する" }).click();

    // main に入れず、タスクは済にならない
    await expect.poll(async () => State.parse(await (await page.request.get("/api/v1/guard/state")).json()).data.stopped.some((s) => s.scope === "task" && s.target === NODE)).toBe(true);
    expect(NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${NODE}`)).json()).data.status).not.toBe("done");

    // セキュリティの画面の止めている物に、止めたタスクが出る
    await nav.getByRole("link", { name: "守り" }).click();
    await expect(page.getByRole("heading", { level: 3, name: `タスク ${NODE}` })).toBeVisible();
  });
});
