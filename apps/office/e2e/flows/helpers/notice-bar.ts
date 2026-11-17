// 上部の帯に出る通知を待つ通しの道具。通しが待つ通知は、ほかの通しの道具が帯で読んで送らない
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { expect } from "../../helpers/test.ts";

/** 使用の上限の通知の題 (サービスと拡張の 3.5) */
export const SPEND_TITLE = "Claude の API の使用の上限に届いた";

/** GitHub のレート制限の通知の題 (サービスと拡張の 3.5) */
export const RATE_TITLE = "GitHub の API のレート制限に届いた";

/** Claude の鍵が断られた通知の題 (サービスと拡張の 3.6) */
export const AUTH_TITLE = "Claude の鍵が断られた";

/** 通しが帯に出るのを待つ通知の題。ほかの通しの道具はこれを読んで送らない */
const AWAITED_TITLES: readonly string[] = [SPEND_TITLE, RATE_TITLE, AUTH_TITLE];

const Notices = z.object({ data: z.array(z.object({ id: z.string(), title: z.string(), readAt: z.string().nullable() }).loose()) });

/**
 * 題の合う読んでいない通知を入口で読む。残すと次の通しの帯に出る
 * @param page 画面を開いたページ
 * @param title 読む通知の題
 */
export async function readNoticesTitled(page: Page, title: string): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  const notices = Notices.parse(await (await page.request.get("/api/v1/notices?limit=100")).json());
  for (const n of notices.data.filter((x) => x.title === title && x.readAt === null)) expect((await page.request.put(`/api/v1/notices/${n.id}/read`, { headers })).status()).toBe(204);
}

/**
 * 通しが待たない読んでいない通知を入口で読む。夜のログインの通知 (日本時間の 0 時から 6 時) のように時刻で溜まる物があり、帯で 1 件ずつ送ると待つ間を超える
 * @param page 画面を開いたページ
 */
async function readOtherNotices(page: Page): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  // 通しはログインの状態を持たずに始まり、画面を開いた後に画面がログインするので、入口が読めるまで待つ
  let body: unknown = null;
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/v1/notices?limit=100");
      if (res.ok()) body = await res.json();
      return res.status();
    })
    .toBe(200);
  const notices = Notices.parse(body);
  for (const n of notices.data.filter((x) => x.readAt === null && !AWAITED_TITLES.includes(x.title))) expect((await page.request.put(`/api/v1/notices/${n.id}/read`, { headers })).status()).toBe(204);
}

/**
 * 上部の帯に題の合う通知が出るまで待つ。帯は未読を 1 件ずつ出すので、ほかの通知は先に入口で読み、待つ間に出た物は帯で読んで送る。ほかの通しが待つ通知は送らない
 * @param page 画面を開いたページ
 * @param role 帯の役 (止まる強さは alert、ほかは status)
 * @param title 待つ通知の題
 * @param timeout 待つ長さのミリ秒
 * @returns 待った通知の帯
 */
export async function noticeBar(page: Page, role: "alert" | "status", title: string, timeout: number): Promise<Locator> {
  await readOtherNotices(page);
  const bar = page.getByRole(role).filter({ hasText: title });
  let top = page.getByRole("alert").or(page.getByRole("status")).filter({ has: page.getByRole("button", { name: "読んだ" }) });
  for (const awaited of AWAITED_TITLES) top = top.filter({ hasNotText: awaited });
  await expect
    .poll(
      async () => {
        if (await bar.isVisible()) return true;
        if (await top.first().isVisible()) await top.first().getByRole("button", { name: "読んだ" }).click();
        // 開いた直後に足された通知は、画面の配りの印を受ける前に出ている事がある。読み直す間 (1 分) を待たず、画面が見えた時の読み直しを起こす。移動の途中で起こせない時は次の確かめに任せる
        else await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))).catch(() => {});
        return false;
      },
      { timeout, intervals: [1_000, 2_000] },
    )
    .toBe(true);
  return bar;
}
