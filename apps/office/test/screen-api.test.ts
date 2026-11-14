// 画面から入口を呼ぶ口。ログインセッションが無いか切れた時は、作り直してから 1 度だけ呼び直す (ログインと記録の 3.2)
import { describe, expect, it } from "vitest";
import { sessionFetch } from "../src/screen/api.ts";

const problem = (status: number, code: string) => new Response(JSON.stringify({ status, code }), { status, headers: { "Content-Type": "application/problem+json" } });

/**
 * 呼ばれた順に答えを返し、呼ばれたメソッドと道を控える fetch の代わりを作る
 * @param answers 返す答え
 * @returns fetch と、控えた呼び出し
 */
function fakeFetch(answers: Response[]) {
  const calls: string[] = [];
  const fetcher = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const type = new Headers(init?.headers).get("Content-Type");
    calls.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${new URL(url).pathname}${type ? ` ${type}` : ""}`);
    const answer = answers.shift();
    return answer ? Promise.resolve(answer) : Promise.reject(new Error("答えが無い"));
  };
  return { fetcher, calls };
}

describe("画面から入口を呼ぶ口", () => {
  it("ログインセッションが無ければ、本文の形を application/json にして作ってから 1 度だけ呼び直す", async () => {
    const { fetcher, calls } = fakeFetch([problem(401, "unauthenticated"), new Response(null, { status: 201 }), Response.json({ data: 1 })]);
    const res = await sessionFetch("http://localhost", fetcher)("http://localhost/api/v1/staff/builder/attendance?day=2026-11-13");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["GET /api/v1/staff/builder/attendance", "POST /api/v1/sessions application/json", "GET /api/v1/staff/builder/attendance"]);
  });

  it("パスキーの確認が要る 401 と、作り直しても通らない 401 はそのまま返す", async () => {
    const stepUp = fakeFetch([problem(401, "step_up_required")]);
    expect((await sessionFetch("http://localhost", stepUp.fetcher)("http://localhost/api/v1/audit-logs")).status).toBe(401);
    expect(stepUp.calls).toEqual(["GET /api/v1/audit-logs"]);
    const denied = fakeFetch([problem(401, "unauthenticated"), problem(401, "unauthenticated")]);
    expect((await sessionFetch("http://localhost", denied.fetcher)("http://localhost/api/v1/me")).status).toBe(401);
    expect(denied.calls).toEqual(["GET /api/v1/me", "POST /api/v1/sessions application/json"]);
  });
});
