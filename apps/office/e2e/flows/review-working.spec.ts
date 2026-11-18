// プルリクエストを出す前のブランチ (作業中の変更) を、社員と仕事の画面のレビューで読む。GitHub は手元の代わりにつなぎ、ブランチの先と compare を置く (タスクとレビューの 3.6)
import { expect, test } from "../helpers/test.ts";
import { z } from "zod";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub, forgetGitHubRoute } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { part } from "./helpers/screen.ts";
import { seedMain } from "./helpers/seed.ts";

const NODE = `019a7b00-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
/** ゲートウェイがタスクを取った時に決めるブランチ */
const BRANCH = `ko/${NODE}`;
const REPO = "example/know-office";
const GITHUB = { headers: { authorization: "Bearer e2e", "user-agent": "know-office-e2e" } };
const REF = `${FAKE_GITHUB}/repos/${REPO}/git/refs/heads`;

const Sha = z.object({ sha: z.string() });

test.describe("know-office の中で確認する", () => {
  test("作業中の変更を見る", async ({ page }) => {
    await page.goto("/settings");
    await useOwnerPasskey(page);
    await connectGitHub(page);

    // 代わりの GitHub に、main の先と、その上で作業中のブランチの先を置く。main は前の通しが置いた返事で動かせない事があるので、main の先は返事で置き、終わりに外す
    const commit = async (parents: string[]): Promise<string> => Sha.parse(await (await page.request.post(`${FAKE_GITHUB}/repos/${REPO}/git/commits`, { ...GITHUB, data: { message: "m", tree: "1".repeat(40), parents } })).json()).sha;
    const base = await commit([]);
    const head = await commit([base]);
    const main = `GET /repos/${REPO}/git/ref/heads/main`;
    // compare は 2 つの先の間の変えたファイルと、共通の祖先を返す。差分も同じ元と先で読む
    const files = [{ filename: "src/attendance.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }];
    const compare = `GET /repos/${REPO}/compare/${base}...${head}`;

    const now = String(Date.now());
    // PR を出す前の、開発担当が作業中のタスク。ブランチは取った時に決まった名前
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, repo, branch, created_by, created_at, updated_at) VALUES ('${NODE}', 'task', NULL, 'office', '作業中の勤怠の直し', NULL, 'build', 'builder', 'doing', 1, '${REPO}', '${BRANCH}', 'president', ${now}, ${now})`,
    );
    try {
      await fakeGitHubRoute(page, main, { ref: "refs/heads/main", object: { sha: base } });
      await fakeGitHubRoute(page, compare, { status: "ahead", merge_base_commit: { sha: base }, files });
      // 開発担当が作業中のブランチに push した後
      expect((await page.request.patch(`${REF}/${BRANCH}`, { ...GITHUB, data: { sha: head, force: true } })).status()).toBe(200);

      // 社員と仕事の画面からタスクを開くと、作業中の変更が出る
      const nav = page.getByRole("navigation", { name: "画面の切り替え" }).first();
      await nav.getByRole("link", { name: "社員と仕事" }).click();
      await page.getByRole("link", { name: /開発担当/ }).first().click();
      await page.getByRole("tab", { name: "仕事の山" }).click();
      await page.getByRole("link", { name: /作業中の勤怠の直し/ }).click();
      await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
      await expect(page.getByText("作業中の変更 (プルリクエストの前)")).toBeVisible();
      await expect(page.getByText(`${REPO} の ${BRANCH}`)).toBeVisible();
      const changes = part(page, "変更");
      await expect(changes.getByText("src/attendance.ts").first()).toBeVisible();
      await expect(changes.getByText("const a = 2;")).toBeVisible();

      // プルリクエストの前なので、承認と差し戻し、その場の直しは出さない
      await expect(page.getByRole("button", { name: "承認する" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "差し戻す" })).toHaveCount(0);
      await expect(part(page, "直す")).toHaveCount(0);
    } finally {
      // 後の通しに残さない。置いた返事とブランチと置いた行を消す
      await forgetGitHubRoute(page, main);
      await forgetGitHubRoute(page, compare);
      await page.request.delete(`${REF}/${BRANCH}`, GITHUB);
      seedMain(`DELETE FROM nodes WHERE id = '${NODE}'`);
      forgetGitHub();
    }
  });
});
