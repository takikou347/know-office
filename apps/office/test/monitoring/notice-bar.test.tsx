// 画面の通知: 上部の帯とダッシュボードの一覧に、入口から読んだ通知を出す (サービスと拡張の 3.5)
import type { Notice } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, createApi } from "../../src/screen/api.ts";
import { fetchNotices, NOTICE_POLL_MS, NoticeBar, NoticeList, watchNotices } from "../../src/screen/parts/notices.tsx";

/**
 * 通知を作る
 * @param id 末尾の番号
 * @param readAt 読んだ時刻。未読なら null
 * @returns 通知
 */
function notice(id: number, readAt: string | null = null): Notice {
  return {
    id: `0190f4a8-0000-7000-8000-${String(id).padStart(12, "0")}`,
    at: "2026-12-08T00:00:00.000Z",
    level: "warn",
    kind: "claude_failing",
    title: `通知 ${String(id)}`,
    body: `本文 ${String(id)}`,
    scope: "office",
    readAt,
  };
}

describe("画面の通知", () => {
  it("上部の帯に、いちばん新しい未読の通知と、ほかの未読の数を出す", () => {
    const html = renderToString(<NoticeBar notices={[notice(3, "2026-12-08T01:00:00.000Z"), notice(2), notice(1)]} onRead={() => {}} />);
    expect(html).toContain("通知 2");
    expect(html).toContain("本文 2");
    expect(html).toContain("ほかに未読が 1 件");
    expect(html).not.toContain("通知 3");
    expect(html).toContain("読んだ");
  });

  it("未読が無ければ帯を出さない", () => {
    expect(renderToString(<NoticeBar notices={[notice(1, "2026-12-08T01:00:00.000Z")]} onRead={() => {}} />)).toBe("");
  });

  it("ダッシュボードの一覧は、時刻を日本時間で出す", () => {
    const html = renderToString(<NoticeList notices={[notice(1)]} state="ok" />);
    expect(html).toContain("通知 1");
    expect(html).toContain("9:00");
  });
});

/** タブの見え方の代わり。visibilitychange を出せる */
class FakeView extends EventTarget {
  hidden = false;

  /**
   * 見え方を変え、visibilitychange を出す
   * @param hidden 隠れているか
   */
  show(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

/**
 * 通知の一覧を読んだ回数を数える、入口の代わり
 * @returns 入口を呼ぶ口と、一覧を読んだ回数
 */
function fakeGate(): { api: Api; reads: () => number } {
  let count = 0;
  const api = createApi("http://localhost", (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v1/notices") count += 1;
    return Promise.resolve(Response.json({ data: [], meta: { traceId: "0".repeat(32), next: null } }));
  });
  return { api, reads: () => count };
}

describe("通知を読み直す", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("5 分以内に出るよう、5 分より短い間で読み直し、止めるとタイマーも止まる", async () => {
    expect(NOTICE_POLL_MS).toBeLessThan(5 * 60_000);
    const { api, reads } = fakeGate();
    const stop = watchNotices(() => void fetchNotices(api), new FakeView());
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(reads()).toBe(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS * 3);
    expect(reads()).toBe(2);
  });

  it("タブが見えない間は読まず、見えた時に 1 回読む", async () => {
    const { api, reads } = fakeGate();
    const view = new FakeView();
    const stop = watchNotices(() => void fetchNotices(api), view);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    view.show(true);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS * 3);
    expect(reads()).toBe(1);
    view.show(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(2);
    stop();
    // 止めた後は見えても読まない
    view.show(true);
    view.show(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(2);
  });
});
