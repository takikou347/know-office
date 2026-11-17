// GitHub を呼ぶ口の、main を進める merge と、main がコミットを含むかを読む inMain。422 は main が先に進んでいる時だけ behind にする (タスクとレビューの 3.1 の 5)
import { describe, expect, it } from "vitest";
import { httpForge } from "../../src/gate/github/forge.ts";

const BASE = "https://github.test";
const REPO = "example/know-office";
const SHA = "b".repeat(40);

/**
 * 道ごとに決めた返事を返す httpForge を作る
 * @param answers 「メソッド 道」から返事への表
 * @returns 呼ぶ口と、受けた要求
 */
function forgeWith(answers: Record<string, { status: number; body?: unknown }>) {
  const seen: string[] = [];
  const fetcher: Parameters<typeof httpForge>[1] = (url, init) => {
    const route = `${init?.method ?? "GET"} ${url.slice(BASE.length)}`;
    seen.push(route);
    const answer = answers[route] ?? { status: 404 };
    return Promise.resolve(Response.json(answer.body ?? {}, { status: answer.status }));
  };
  return { seen, forge: httpForge(BASE, fetcher, { appId: 1, token: () => Promise.resolve("ghs_test") }) };
}

const PATCH = `PATCH /repos/${REPO}/git/refs/heads/main`;
const COMPARE = `GET /repos/${REPO}/compare/main...${SHA}`;

describe("main を進める", () => {
  it("進められたら merged", async () => {
    const { forge } = forgeWith({ [PATCH]: { status: 200, body: { ref: "refs/heads/main", object: { sha: SHA } } } });
    expect(await forge.merge(REPO, { branch: "ko/x", sha: SHA })).toBe("merged");
  });

  it.each(["diverged", "behind"])("422 で main が先に進んでいる (%s) なら behind にする", async (status) => {
    const { forge, seen } = forgeWith({ [PATCH]: { status: 422, body: { message: "Update is not a fast forward" } }, [COMPARE]: { status: 200, body: { status, files: [] } } });
    expect(await forge.merge(REPO, { branch: "ko/x", sha: SHA })).toBe("behind");
    expect(seen).toEqual([PATCH, COMPARE]);
  });

  it("ルールセットが断った 422 (main は先に進んでいない) は upstream_failed のまま", async () => {
    const { forge } = forgeWith({ [PATCH]: { status: 422, body: { message: "Repository rule violations found" } }, [COMPARE]: { status: 200, body: { status: "ahead", files: [] } } });
    await expect(forge.merge(REPO, { branch: "ko/x", sha: SHA })).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("422 以外の失敗は比べずに upstream_failed", async () => {
    const { forge, seen } = forgeWith({ [PATCH]: { status: 500 } });
    await expect(forge.merge(REPO, { branch: "ko/x", sha: SHA })).rejects.toMatchObject({ code: "upstream_failed" });
    expect(seen).toEqual([PATCH]);
  });
});

describe("main がコミットを含むか", () => {
  it.each([
    ["ahead", true],
    ["identical", true],
    ["diverged", false],
    ["behind", false],
  ])("main が %s なら %s", async (status, included) => {
    const { forge } = forgeWith({ [`GET /repos/${REPO}/compare/${SHA}...main`]: { status: 200, body: { status, files: [] } } });
    expect(await forge.inMain(REPO, SHA)).toBe(included);
  });
});
