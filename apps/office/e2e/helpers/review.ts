// レビューの画面の通しの手伝い。入口のレビューの返事を境目のモックで返し、画面が呼んだ道を並べる。入口の中身は test/review/ で確かめる
import type { ReviewHead } from "@know-office/core";
import type { Page } from "@playwright/test";
import { z } from "zod";

/** 見本のレビューのタスク ID */
export const REVIEW_ID = "019a7b00-0000-7000-8000-0000000000d9";

/** 見本のレビューの道 */
export const REVIEW_PATH = `/staff/builder/tasks/${REVIEW_ID}`;

const META = { traceId: "0".repeat(32) };
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

/**
 * 足した行だけの 1 ファイルの差分を作る
 * @param path ファイルの道
 * @param lines 行の数
 * @returns 入口の差分の形
 */
export function addedDiff(path: string, lines: number) {
  return { path, language: "typescript", hunks: [{ oldStart: 0, newStart: 1, lines: Array.from({ length: lines }, (_, i) => `+export const v${String(i)} = ${String(i)};`) }] };
}

/** 前と後を並べる見本の差分 */
const CHANGED = {
  path: "src/attendance.ts",
  language: "typescript",
  hunks: [{ oldStart: 10, newStart: 10, lines: [" const a = 1;", "-const empty = null;", "+const empty = 0;", " const b = 2;"] }],
};

/** 画面が入口に出した要求 */
export type Called = { method: string; path: string };

/**
 * 見本のレビューを入口の返事として置く
 * @param page 開くページ
 * @param options 最初のファイルの差分の行の数。無ければ 4 行の見本
 * @param options.firstLines 最初のファイルを足した行の数
 * @returns 画面が /api/v1/reviews/ に出した要求
 */
export async function stubReview(page: Page, options: { firstLines?: number } = {}): Promise<Called[]> {
  const called: Called[] = [];
  const first = options.firstLines === undefined ? CHANGED : addedDiff("src/attendance.ts", options.firstLines);
  const head = {
    nodeId: REVIEW_ID,
    repo: "example/know-office",
    prNumber: 1,
    branch: "ko/019a7b00-attendance-table",
    baseSha: BASE,
    headSha: HEAD,
    lastSeenSha: null,
    working: false,
    checks: [{ name: "verify", ok: true }],
    reviewerSummary: "空の日の勤怠を 0 で出すように直した。気になる所は無い",
    reviewerVerdict: "approve",
    files: [
      { path: "src/attendance.ts", status: options.firstLines === undefined ? "modified" : "added", seen: false },
      { path: "src/format.ts", status: "modified", seen: false },
    ],
  } satisfies ReviewHead;
  await page.route(
    (url) => url.pathname.startsWith(`/api/v1/reviews/${REVIEW_ID}`),
    async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      called.push({ method, path: `${url.pathname}${url.search}` });
      const rest = url.pathname.slice(`/api/v1/reviews/${REVIEW_ID}`.length);
      if (method === "GET" && rest === "") return route.fulfill({ json: { data: head, meta: META } });
      if (method === "GET" && rest === "/diff") {
        const path = url.searchParams.get("path") ?? "";
        return route.fulfill({ json: { data: path === "src/attendance.ts" ? first : addedDiff(path, 3), meta: META } });
      }
      if (method === "PUT" && rest === "/seen") return route.fulfill({ status: 204 });
      // 直す欄 (エディタ) が読むファイルの中身
      if (method === "GET" && rest === "/file") return route.fulfill({ json: { data: { content: "const a = 1;\n" }, meta: META } });
      if (method === "POST" && rest === "/verdict") {
        const sent: unknown = route.request().postDataJSON();
        const verdict = z.object({ verdict: z.string() }).loose().safeParse(sent).data?.verdict ?? "approve";
        return route.fulfill({ json: { data: { nodeId: REVIEW_ID, ownerVerdict: verdict }, meta: META } });
      }
      return route.fulfill({ status: 404, contentType: "application/problem+json", body: JSON.stringify({ code: "not_found", traceId: META.traceId }) });
    },
  );
  return called;
}

/**
 * 画面が出した要求を、重ねずに「メソッド 道」で並べる。開発の画面は React の StrictMode で読み込みを 2 度走らせるので、同じ要求は 1 つに数える
 * @param called 画面が出した要求
 * @returns 出た順の「メソッド 道」
 */
export function distinct(called: readonly Called[]): string[] {
  return [...new Set(called.map((c) => `${c.method} ${c.path}`))];
}
