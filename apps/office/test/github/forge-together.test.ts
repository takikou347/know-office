// 設計書を同じ時に直す時に使う、GitHub を呼ぶ口の 2 つ。fastForwardable は main に fast-forward で進められるか、pullOf はブランチで開いた PR を探す (開発の回し方の 3.6)
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

describe("設計書を同じ時に直す", () => {
  it.each([
    ["ahead", true],
    ["identical", true],
    ["diverged", false],
    ["behind", false],
  ])("事前の確かめは ahead と identical だけ通す (%s は %s)", async (status, ok) => {
    const { forge, seen } = forgeWith({ [`GET /repos/${REPO}/compare/main...${SHA}`]: { status: 200, body: { status, files: [] } } });
    expect(await forge.fastForwardable(REPO, SHA)).toBe(ok);
    expect(seen).toEqual([`GET /repos/${REPO}/compare/main...${SHA}`]);
  });

  it("ブランチで開いた PR があれば番号と先を返し、無ければ null", async () => {
    const route = `GET /repos/${REPO}/pulls?head=example%3Ako%2Fabc12345-spec&state=open&per_page=2`;
    const found = forgeWith({ [route]: { status: 200, body: [{ number: 7, base: { sha: "a".repeat(40) }, head: { ref: "ko/abc12345-spec", sha: SHA } }] } });
    expect(await found.forge.pullOf(REPO, "ko/abc12345-spec")).toEqual({ number: 7, baseSha: "a".repeat(40), headSha: SHA });
    // head のブランチが違う PR (GitHub が別の PR を返した時) は使わない
    const other = forgeWith({ [route]: { status: 200, body: [{ number: 8, base: { sha: "a".repeat(40) }, head: { ref: "ko/other", sha: SHA } }] } });
    expect(await other.forge.pullOf(REPO, "ko/abc12345-spec")).toBeNull();
    const none = forgeWith({ [route]: { status: 200, body: [] } });
    expect(await none.forge.pullOf(REPO, "ko/abc12345-spec")).toBeNull();
  });
});
