import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { FAKES } from "../helpers/fakes.ts";
import { connectGitHub, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { boxOf, pictureOf, roomOf } from "../helpers/room.ts";
import { readNoticesTitled } from "./helpers/notice-bar.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { post } from "./helpers/screen.ts";
import { seedMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";
import { clockIn, forgetReplies, releaseHeld, scriptReply, staffNow, staffState } from "./helpers/staff.ts";
import { addTask, NodeDetail, openTree, PURPOSE, type Tree, Trees } from "./helpers/staff-work.ts";

// オフィスの部屋が、本物のゲートウェイのレビューの判断を、配信で届いた出来事として見せる。GitHub は手元の代わりにつなぎ、プルリクエストの変更だけを置く (画面の全体の 3.2)
// 社員が待つ時は休憩所に並び、狭い幅でも広い幅でも各社員の姿を押せる。社員は本物の入口で待たせ、ゲートウェイの返事は差し替えない

const NODE = "019a7b00-0000-7000-8000-0000000000e7";
const REVIEW = "019a7b00-0000-7000-8000-0000000000e8";
const PR = 7;
const HEAD = "c".repeat(40);

test.describe("オフィスの部屋", () => {
  // 後の通し (設定など) は GitHub をつないでいない前提なので、つないだ物を消して返す
  test.afterEach(async ({ page }) => {
    forgetGitHub();
    // 差し戻したタスクは開発担当に戻り、勤務の時間の外なら開発担当を呼び出す。持たせたままにすると、後の通しで開発担当が呼ばれたまま次のタスクを取らずに退勤するので、空ける
    if ((await staffNow(page, "builder")).nodeId === NODE) await releaseHeld(page, "builder");
  });

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

/** 休憩所に並べる 3 人。社員 ID と役職 */
const RESTING = [
  ["president", "社長"],
  ["builder", "開発担当"],
  ["reviewer", "レビュー担当"],
] as const;

/** 木の 1 件の状態 */
const Finished = z.object({ status: z.string() }).loose();

/** 止めた時の返事 */
const Stopped = z.object({ data: z.object({ stopId: z.string() }).loose() });

/** 社員を止めた時の通知の題。待ちから戻すために止めた物は、後の通しの帯に残さない */
const STOP_TITLE = "社員を止めた";

/** 休憩所で待たせるタスクの題の頭。前の通しが落ちて残した物を探す */
const REST_TASK = "休憩所で待つタスク";

/** 休憩所の並びを押す幅。狭い幅 (360) では姿が近く、押せる箱を分けて並べる */
const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 360, height: 780 },
] as const;

/**
 * 代わりの Claude API で、社員の呼び出しをレートの上限に切り替えるか戻す
 * @param page 画面を開いたページ
 * @param staffId 社員
 * @param on 切り替えるか。false で戻す
 */
async function rateLimit(page: Page, staffId: string, on: boolean): Promise<void> {
  expect((await page.request.post(`${FAKES}/anthropic/__fake/limit`, { data: { staffId, limit: on ? "rate" : null } })).status()).toBe(204);
}

/**
 * レートの上限を戻し、休憩所で待たせるタスクのうち終わっていない物を見送りにし、待ったままの社員を止めて再開して待ちから戻し、止めた通知を読む。残すと後の通しで社員が先に取り、待ったままになり、帯に通知が出る
 * @param page 画面を開いたページ
 */
async function leaveRest(page: Page): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  for (const [id] of RESTING) await rateLimit(page, id, false);
  const left = Trees.parse(await (await page.request.get(`/api/v1/nodes?rootId=${PURPOSE}`)).json())
    .data.flatMap(function walk(n: Tree): Tree[] {
      return [n, ...n.children.flatMap(walk)];
    })
    .filter((n) => n.title.startsWith(`${REST_TASK} `))
    // 済んだ物と見送った物は読み直さない。前の通しの分も木に残り続け、1 件ずつ読むと送信元の 1 分の数 (300) に届く
    .filter((n) => !["done", "dropped"].includes(Finished.parse(n).status));
  const statusOf = async (id: string) => NodeDetail.parse(await (await page.request.get(`/api/v1/nodes/${id}`)).json()).data.status;
  for (const n of left) {
    // SDK が上限の返事で終えるとタスクは待ちに戻る。前の通しが途中で落ちて作業中に残した物は、見送りにできないので終わりの返事で終えさせる
    if ((await statusOf(n.id)) === "doing") {
      const [owner] = RESTING.find(([id]) => n.title.startsWith(`${REST_TASK} ${id} `)) ?? [];
      if (owner !== undefined) await scriptReply(page, owner, [{ type: "text", text: "休憩所の通しの前に終えた" }], "end_turn");
      await expect.poll(() => statusOf(n.id), { timeout: 240_000 }).not.toBe("doing");
    }
    const { status, version } = NodeDetail.parse(await (await page.request.get(`/api/v1/nodes/${n.id}`)).json()).data;
    if (status === "done" || status === "dropped") continue;
    expect((await page.request.patch(`/api/v1/nodes/${n.id}`, { headers, data: { version, status: "dropped" } })).status()).toBe(200);
  }
  // 上限の待ちは次の呼び出しが通るまで解けないので、止めて再開し、待つ前の様子に戻す
  for (const [id] of RESTING) {
    if ((await staffState(page, id)) !== "waiting") continue;
    const stopped = await page.request.post("/api/v1/guard/stops", { headers, data: { scope: "staff", target: id, reason: "休憩所の通しの後に待ちから戻す" } });
    expect(stopped.status()).toBe(201);
    const { stopId } = Stopped.parse(await stopped.json()).data;
    expect(await post(page, `/api/v1/guard/stops/${stopId}/resume`)).toBe(200);
    await expect.poll(() => staffState(page, id), { timeout: 30_000 }).not.toMatch(/^(waiting|stopped)$/);
  }
  await readNoticesTitled(page, STOP_TITLE);
  // 使われずに残った終わりの返事を、後の通しの社員の呼び出しに返さない
  for (const [id] of RESTING) await forgetReplies(page, id);
}

test.describe("画面の一覧", () => {
  test("休憩所に並んだ社員の姿を押す", async ({ page }) => {
    // 3 人を出勤させ、タスクを渡して上限の返事で待たせる
    test.slow();
    await openTree(page);
    await leaveRest(page);
    const restores: (() => Promise<void>)[] = [];
    await settle(
      async () => {
        for (const [id] of RESTING) restores.push(await clockIn(page, id));
        // 社員の呼び出しが Claude の API のレートの上限に当たると、ゲートウェイのプロキシが社員を待つ様子にする
        for (const [id] of RESTING) await rateLimit(page, id, true);
        await page.goto("/goals");
        for (const [id, role] of RESTING) await addTask(page, `${REST_TASK} ${id} ${String(Date.now())}`, role);
        for (const [id] of RESTING) await expect.poll(() => staffState(page, id), { timeout: 60_000 }).toBe("waiting");

        for (const viewport of WIDTHS) {
          await page.setViewportSize(viewport);
          for (const [id, role] of RESTING) {
            await page.goto("/office");
            const room = roomOf(page);
            await expect(room.locator("canvas")).toBeVisible();
            // 3 人とも休憩所で待つ姿で並ぶ
            for (const [, r] of RESTING) await expect(room.getByRole("link", { name: `${r} 待っている` })).toBeAttached();
            // 名札の置き場は姿を覆う箱と同じ所にあるので、その真ん中が姿の真ん中
            const figure = await room.locator(`.ko-office-label[href="/staff/${id}"]`).boundingBox();
            if (!figure) throw new Error(`${role}の姿が無い`);
            await page.mouse.click(figure.x + figure.width / 2, figure.y + figure.height / 2);
            await expect(page).toHaveURL(new RegExp(`/staff/${id}$`));
            await expect(page.getByRole("log", { name: `${role}との会話` })).toBeVisible();
          }
        }
      },
      [
        () => page.setViewportSize(WIDTHS[0]),
        () => leaveRest(page),
        // 広げた勤務の時刻は、最初に広げた社員の戻しが元に戻す。後の社員は広げていないので何もしない
        ...[0, 1, 2].map((i) => () => restores[i]?.()),
      ],
    );
  });
});
