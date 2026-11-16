// GitHub の上限の返事から、送り直してよいまでの秒を決める (タスクとレビューの 3.3)
import { describe, expect, it } from "vitest";
import { githubRetryAfter } from "../../src/gate/github/app.ts";

const DATE = "Tue, 01 Jan 2030 00:00:00 GMT";
const RESET_AT_DATE = 1893456000;

/**
 * GitHub の返事を作る
 * @param status ステータス
 * @param headers ヘッダー
 * @returns 返事
 */
const reply = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers: { date: DATE, ...headers } });

describe("GitHub の上限の待ち", () => {
  it("retry-after があれば、その秒を待つ", () => {
    expect(githubRetryAfter(reply(403, { "retry-after": "30" }))).toBe(30);
    expect(githubRetryAfter(reply(429, { "retry-after": "30", "x-ratelimit-reset": String(RESET_AT_DATE + 999) }))).toBe(30);
  });

  it("残りが 0 なら、x-ratelimit-reset を返事の時刻から引いた秒を待つ", () => {
    expect(githubRetryAfter(reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_AT_DATE + 125) }))).toBe(125);
  });

  it("待つ時刻が無い 429 は 1 分待ち、待ちは 1 秒から 1 時間に収める", () => {
    expect(githubRetryAfter(reply(429))).toBe(60);
    expect(githubRetryAfter(reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_AT_DATE - 5) }))).toBe(1);
    expect(githubRetryAfter(reply(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_AT_DATE + 86_400) }))).toBe(3600);
  });

  it("上限でない 403 と、ほかの失敗は上限とみなさない", () => {
    expect(githubRetryAfter(reply(403, { "x-ratelimit-remaining": "4999" }))).toBeNull();
    expect(githubRetryAfter(reply(404))).toBeNull();
    expect(githubRetryAfter(reply(500, { "retry-after": "30" }))).toBeNull();
  });
});
