import { expect, test } from "../helpers/test.ts";
import { connectGitHub, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { boxOf, pictureOf, roomOf } from "../helpers/room.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";
import { clockIn } from "./helpers/staff.ts";

// オフィスの部屋が、本物のゲートウェイのレビューの判断を、配信で届いた出来事として見せる。GitHub は手元の代わりにつなぎ、プルリクエストの変更だけを置く (画面の全体の 3.2)

const NODE = "019a7b00-0000-7000-8000-0000000000e7";
const REVIEW = "019a7b00-0000-7000-8000-0000000000e8";
const PR = 7;
const HEAD = "c".repeat(40);

test.describe("オフィスの部屋", () => {
  // 後の通し (設定など) は GitHub をつないでいない前提なので、つないだ物を消して返す
  test.afterEach(() => forgetGitHub());

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

    // 部屋を開いたままにする。初めて読み込んだ時の様子は出来事にしない。
    // 画面の中で移ると、設定の画面の間に届いた社員の出来事 (代わりのワークスペースで働く社員の出勤など) を持ち込むので、読み込み直して開く
    await page.goto("/office");
    const room = page.getByRole("region", { name: "オフィスの部屋" });
    await expect(room.getByRole("status")).toHaveText("直近の出来事はまだありません");

    // 差し戻しの後に開発担当が働き始めた出来事が続けて届くと読み上げが替わるので、読み上げた文を順に控える
    await room.getByRole("status").evaluate((el) => {
      const said: string[] = [];
      Object.assign(window, { officeSaid: said });
      new MutationObserver(() => said.push(el.textContent ?? "")).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const said = () =>
      page.evaluate(() => {
        const list: unknown = Reflect.get(window, "officeSaid");
        return Array.isArray(list) ? list.join("\n") : "";
      });

    // 別のタブで本物のレビューを開いて差し戻すと、開いている部屋に配信で差し戻しの出来事が届く
    const other = await page.context().newPage();
    await other.goto(`/staff/builder/tasks/${NODE}`);
    await expect(other.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
    await other.getByRole("button", { name: "差し戻す" }).click();
    await expect(other.getByText("差し戻し、作る役に戻しました")).toBeVisible();
    await expect.poll(said).toMatch(/オーナーが「勤怠の表を足す」を開発担当に差し戻した/);
    await other.close();

    // 読み直すと、届いた出来事は持ち越さない
    await page.reload();
    await expect(page.getByRole("region", { name: "オフィスの部屋" }).getByRole("status")).toHaveText("直近の出来事はまだありません");
  });

  test("動きを減らす設定では動かさない", async ({ page }) => {
    // 退勤した社員は部屋に居ないので、動く姿を見るためにレビュー担当を出勤させる
    // 画面を開いてログインセッションができてから、入口に直に聞く
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 3, name: "勤務の時刻", exact: true })).toBeVisible();
    const restore = await clockIn(page, "reviewer");
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/office");
      await expect(roomOf(page).locator("canvas")).toBeVisible();
      await expect(page.getByRole("list", { name: "社員の様子" })).toHaveCount(0);
      // 初めから動かさないので、止めるボタンは出さない
      await expect(page.getByRole("button", { name: "動きを止める" })).toHaveCount(0);
      const first = await boxOf(page, /レビュー担当/);
      const before = await pictureOf(page);
      await page.waitForTimeout(600);
      expect(await boxOf(page, /レビュー担当/)).toEqual(first);
      expect((await pictureOf(page)).equals(before)).toBe(true);
    } finally {
      await restore();
    }
  });

  test("動きを止めるボタン", async ({ page }) => {
    // 退勤した社員は部屋に居ないので、動く姿を見るためにレビュー担当を出勤させる
    // 画面を開いてログインセッションができてから、入口に直に聞く
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 3, name: "勤務の時刻", exact: true })).toBeVisible();
    const restore = await clockIn(page, "reviewer");
    try {
      await page.goto("/office");
      const halt = page.getByRole("button", { name: "動きを止める" });
      await expect(halt).toHaveAttribute("aria-pressed", "false");
      // ボタンは部屋の絵より先に出るので、絵が出てから撮る
      await expect(roomOf(page).locator("canvas")).toBeVisible();
      // 確かめ方が効いている事: 動いている間は、時間が経つと絵が変わる
      const moving = await pictureOf(page);
      await page.waitForTimeout(600);
      expect((await pictureOf(page)).equals(moving)).toBe(false);

      await halt.click();
      await expect(halt).toHaveAttribute("aria-pressed", "true");
      await expect(roomOf(page)).toHaveAttribute("data-motion", "still");
      const still = await pictureOf(page);
      await page.waitForTimeout(600);
      expect((await pictureOf(page)).equals(still)).toBe(true);

      await halt.click();
      await expect(halt).toHaveAttribute("aria-pressed", "false");
      await expect(roomOf(page)).toHaveAttribute("data-motion", "moving");
      await page.waitForTimeout(600);
      expect((await pictureOf(page)).equals(still)).toBe(false);
    } finally {
      await restore();
    }
  });
});
