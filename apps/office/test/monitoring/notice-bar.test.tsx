// 画面の通知: 上部の帯とダッシュボードの一覧に、入口から読んだ通知を出す (サービスと拡張の 3.5)
import type { Notice } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOTICE_POLL_MS, NoticeBar, NoticeList } from "../../src/screen/parts/notices.tsx";

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

  it("5 分以内に出るよう、5 分より短い間で読み直す", () => {
    expect(NOTICE_POLL_MS).toBeLessThan(5 * 60_000);
  });
});
