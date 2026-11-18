// レビューのその場の直しで、エディタの補完と型の誤りを本物のルート (GET /api/v1/reviews/{nodeId}/lsp) と手元の代わりのワークスペースの tsc --lsp で出す。
// ゲートウェイの返事は差し替えず、GitHub は手元の代わりの GitHub に木 (tarball) とファイルを置き、ワークスペースは開発のコンテナの代わりが起こす (タスクとレビューの 3.2)
import type { Page, WebSocket } from "@playwright/test";
import { z } from "zod";
import { FAKES } from "../helpers/fakes.ts";
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, FAKE_GITHUB, fakeGitHubRoute, forgetGitHub } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { part, post } from "./helpers/screen.ts";
import { seedMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";
import { resumeStaff, staffNow } from "./helpers/staff.ts";
import { treeTarball } from "./helpers/tree.ts";

/**
 * 通しごとに新しい ID を作る。タスクの出来事は年ごとの記録に残り消さないので、前の通しの出来事と混ぜない
 * @returns UUID v7 の形の ID
 */
function flowId(): string {
  const hex = crypto.randomUUID().replaceAll("-", "");
  return `019a7b00-0000-7${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(6, 18)}`;
}

/**
 * 40 字の小文字の 16 進のコミットを作る
 * @returns コミット
 */
function flowSha(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ファイルの中のテストは同じタスクと先を使う。ワークスペースは同じ木を 1 度だけ取るので、tarball の回数の上限 (1 時間 20 回) を通しで使い切らない
const NODE = flowId();
const REVIEW = flowId();
const HEAD = flowSha();
const BASE = flowSha();
const REPO = "example/know-office";
const PR = 9000 + Math.floor(Math.random() * 900);
const BRANCH = `ko/${NODE.slice(0, 8)}-editor`;
const FILE = "src/Card.tsx";
const CARD = 'import { Button } from "knowidea-ui";\n\nexport const card = <Button>保存</Button>;\n';
const TREE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true }, include: ["src"] }),
  [FILE]: CARD,
};
const GITHUB = { headers: { authorization: "Bearer e2e", "user-agent": "know-office-e2e" } };

const Boots = z.record(z.string(), z.number());
const Stopped = z.object({ data: z.object({ stopId: z.string() }) });

/**
 * 代わりのワークスペースを社員ごとに起こした回数を読む
 * @param page 開いているページ
 * @returns 開発担当を起こした回数
 */
async function builderBoots(page: Page): Promise<number> {
  return Boots.parse(await (await page.request.get(`${FAKES}/workspace/__fake/boots`)).json())["builder"] ?? 0;
}

/**
 * 補完で起こした開発担当のワークスペースを、社員の停止で止めてから再開する。勤務の外なら止めるだけで作り直さないので、1 日の予算に積むのは通しの間だけになる
 * @param page 開いているページ
 */
async function stopEditorWorkspace(page: Page): Promise<void> {
  const res = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "staff", target: "builder", reason: "補完の通しで起こしたワークスペースを止める" } });
  expect(res.status()).toBe(201);
  expect(await post(page, `/api/v1/guard/stops/${Stopped.parse(await res.json()).data.stopId}/resume`)).toBe(200);
}

/**
 * GitHub をつなぎ、開発担当がプルリクエストを出してレビュー担当が承認したレビューを置き、代わりの GitHub に変えたファイルと木を置く
 * @param page 開いているページ
 * @returns 後始末
 */
async function seedReview(page: Page): Promise<(() => unknown)[]> {
  await page.goto("/settings");
  await useOwnerPasskey(page);
  await connectGitHub(page);
  // 前の通しが止めたままにした社員がいれば、補完で起こせないので再開する
  await resumeStaff(page);
  const undo = [
    () => stopEditorWorkspace(page),
    () => seedMain(`DELETE FROM reviews WHERE id = '${REVIEW}'; DELETE FROM nodes WHERE id = '${NODE}';`),
    () => page.request.delete(`${FAKE_GITHUB}/__fake/archives/${REPO}/${HEAD}`, GITHUB),
    () => forgetGitHub(),
  ];
  const now = String(Date.now());
  seedMain(
    "INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES " +
      `('${NODE}', 'task', NULL, 'office', '通しでボタンのカードを足す', NULL, 'build', 'builder', 'review', 0, '${REPO}', '${BRANCH}', ${String(PR)}, 'president', ${now}, ${now}); ` +
      "INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, last_seen_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict) VALUES " +
      `('${REVIEW}', '${NODE}', '${REPO}', ${String(PR)}, '${BRANCH}', '${BASE}', '${HEAD}', NULL, '[]', 'ボタンのカードを足した', 'approve', NULL);`,
  );
  await fakeGitHubRoute(page, `GET /repos/${REPO}/pulls/${String(PR)}/files`, [{ filename: FILE, status: "added", patch: `@@ -0,0 +1,3 @@\n${CARD.trimEnd().split("\n").map((l) => `+${l}`).join("\n")}` }]);
  await fakeGitHubRoute(page, `GET /repos/${REPO}/contents/${FILE}`, { type: "file", encoding: "base64", content: Buffer.from(CARD).toString("base64") });
  const placed = await page.request.put(`${FAKE_GITHUB}/__fake/archives/${REPO}/${HEAD}`, { ...GITHUB, data: treeTarball(TREE) });
  expect(placed.status()).toBe(204);
  return undo;
}

/**
 * レビューを開き、直すファイルを選んでエディタを出す
 * @param page 開いているページ
 * @returns エディタの書く所
 */
async function openEditor(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto(`/staff/builder/tasks/${NODE}`);
  await expect(page.getByRole("heading", { level: 2, name: "変更のレビュー" })).toBeVisible();
  const fix = part(page, "直す");
  await fix.getByRole("combobox", { name: "直すファイル" }).click();
  await page.getByRole("option", { name: FILE }).click();
  const editor = fix.locator(".cm-content");
  await expect(editor).toContainText("export const card");
  return editor;
}

/**
 * 書く所の終わりに行を足す
 * @param page 開いているページ
 * @param editor エディタの書く所
 * @param text 足す行
 */
async function typeAtEnd(page: Page, editor: ReturnType<Page["locator"]>, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

test.describe("ワークスペースを起こす時", () => {
  test("読むだけ", async ({ page }) => {
    const sockets: string[] = [];
    page.on("websocket", (ws: WebSocket) => sockets.push(new URL(ws.url()).pathname));
    const undo = await seedReview(page);
    await settle(async () => {
      const before = await builderBoots(page);
      await page.goto(`/staff/builder/tasks/${NODE}`);
      await expect(part(page, "変更").getByText("export const card")).toBeVisible();
      // 直すファイルを選んでエディタを出しても、書き換えるまではつながない
      await openEditor(page);
      expect(sockets.filter((p) => p.endsWith("/lsp"))).toEqual([]);
      expect(await builderBoots(page)).toBe(before);
    }, undo);
  });

  test("補完を使う", async ({ page }) => {
    test.setTimeout(90_000);
    const sockets: string[] = [];
    page.on("websocket", (ws: WebSocket) => sockets.push(new URL(ws.url()).pathname));
    const undo = await seedReview(page);
    await settle(async () => {
      const before = await builderBoots(page);
      // 勤務の外なら止まっている (前の通しは終わりに止める)。勤務の間は動いているワークスペースにつなぐ
      const off = (await staffNow(page, "builder")).state === "off";
      const editor = await openEditor(page);
      await typeAtEnd(page, editor, "\nexport const size: number = card.");
      await page.keyboard.press("Control+Space");
      // 書き換えると補完の口を開き、ワークスペースが止まっていれば 1 回だけ起こして tsc の候補を出す
      await expect(page.getByRole("option", { name: /^props/ })).toBeVisible({ timeout: 60_000 });
      expect(sockets.filter((p) => p === `/api/v1/reviews/${NODE}/lsp`)).toHaveLength(1);
      expect(await builderBoots(page)).toBe(off ? before + 1 : before);
      if (!off) return;
      // 社員の停止で止めると補完の接続も閉じ、次に書き換えた時にもう 1 回だけ起こしてつなぎ直す
      await stopEditorWorkspace(page);
      await page.keyboard.press("Escape");
      await page.keyboard.type("props;");
      await expect.poll(() => builderBoots(page), { timeout: 60_000 }).toBe(before + 2);
      await expect.poll(() => sockets.filter((p) => p === `/api/v1/reviews/${NODE}/lsp`).length).toBe(2);
    }, undo);
  });
});

test.describe("読みやすさと補完", () => {
  test("コンポーネントの引数を補完する", async ({ page }) => {
    test.setTimeout(90_000);
    const undo = await seedReview(page);
    await settle(async () => {
      const editor = await openEditor(page);
      await typeAtEnd(page, editor, "\nexport const other = <Button va");
      await page.keyboard.press("Control+Space");
      // knowidea-ui の Button の引数を、ワークスペースの型の束から出す。HTML の属性も並ぶので、書き始めた字で絞る
      await expect(page.getByRole("option", { name: /^variant/ })).toBeVisible({ timeout: 60_000 });
    }, undo);
  });

  test("型の誤り", async ({ page }) => {
    test.setTimeout(90_000);
    const undo = await seedReview(page);
    await settle(async () => {
      const editor = await openEditor(page);
      await typeAtEnd(page, editor, '\nexport const count: number = "3";');
      // 書き換えると tsc の診断を求め、型の合わない所に下線を引く
      const underline = editor.locator(".cm-lintRange-error");
      await expect(underline).toHaveText('count', { timeout: 60_000 });
      await underline.hover();
      await expect(page.locator(".cm-tooltip-lint")).toContainText(/'string'.*'number'/);
    }, undo);
  });
});
