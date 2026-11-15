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

/**
 * 外から終わらせられる約束を作る
 * @returns 約束と、それを終わらせる関数
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  const held: { resolve?: () => void } = {};
  const promise = new Promise<void>((done) => {
    held.resolve = done;
  });
  return { promise, resolve: () => held.resolve?.() };
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

  it("同時に呼んだ 3 つがどれも 401 でも、ログインセッションは 1 つだけ作る", async () => {
    const posts: string[] = [];
    let signedIn = false;
    // 3 つ目の 401 は、ログインセッションを作り終えた後に返す。先に送った要求の返事が遅れて届いた時にあたる
    const late = deferred();
    const fetcher = async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path === "/api/v1/sessions") {
        posts.push(path);
        signedIn = true;
        return new Response(null, { status: 201 });
      }
      const sentWithSession = signedIn;
      if (path === "/api/v1/slow" && !sentWithSession) await late.promise;
      return sentWithSession ? Response.json({ data: path }) : problem(401, "unauthenticated");
    };
    const call = sessionFetch("http://localhost", fetcher);
    const slow = call("http://localhost/api/v1/slow");
    const fast = await Promise.all([call("http://localhost/api/v1/me"), call("http://localhost/api/v1/notices")]);
    expect(fast.map((r) => r.status)).toEqual([200, 200]);
    late.resolve();
    expect((await slow).status).toBe(200);
    expect(posts).toEqual(["/api/v1/sessions"]);
  });
});
