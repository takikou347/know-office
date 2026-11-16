// GitHub を呼ぶ口の、既定のブランチの先のコミットを読む defaultHead。リポジトリを読み、既定のブランチの名前を道の形にして ref を読む (サービスと拡張の 3.2)
import { describe, expect, it } from "vitest";
import { createFakeGitHub } from "../../dev/github.ts";
import { httpForge } from "../../src/gate/github/forge.ts";

const BASE = "https://github.test";
const REPO = "example/know-office";
const BRANCH = "release/1.0+fix";

/**
 * 代わりの GitHub に向けた httpForge を作る
 * @returns 呼ぶ口と、代わりの GitHub
 */
function forgeOnFake() {
  const github = createFakeGitHub();
  const fetcher: Parameters<typeof httpForge>[1] = (url, init) => Promise.resolve(github.app.request(url.slice(BASE.length), init));
  return { github, forge: httpForge(BASE, fetcher, { appId: 1, token: () => Promise.resolve("ghs_test") }) };
}

describe("既定のブランチの先を読む", () => {
  it("リポジトリを読んでから、/ を残して符号にした既定のブランチの ref を読み、コミットを返す", async () => {
    const { github, forge } = forgeOnFake();
    github.set(`GET /repos/${REPO}`, { full_name: REPO, private: false, default_branch: BRANCH });
    github.set(`GET /repos/${REPO}/git/ref/heads/release/1.0%2Bfix`, { ref: `refs/heads/${BRANCH}`, object: { sha: "c".repeat(40) } });
    expect(await forge.defaultHead(REPO)).toBe("c".repeat(40));
    expect(github.requests.map((r) => r.route)).toEqual([`GET /repos/${REPO}`, `GET /repos/${REPO}/git/ref/heads/release/1.0%2Bfix`]);
  });

  it("コミットの形でない sha は返さない", async () => {
    const { github, forge } = forgeOnFake();
    github.set(`GET /repos/${REPO}`, { full_name: REPO, private: false, default_branch: "main" });
    github.set(`GET /repos/${REPO}/git/ref/heads/main`, { ref: "refs/heads/main", object: { sha: "../../etc" } });
    await expect(forge.defaultHead(REPO)).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("リポジトリかブランチが 404 なら upstream_failed にし、ほかの道を読まない", async () => {
    const { github, forge } = forgeOnFake();
    await expect(forge.defaultHead(REPO)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(github.requests.map((r) => r.route)).toEqual([`GET /repos/${REPO}`]);
    github.set(`GET /repos/${REPO}`, { full_name: REPO, private: false, default_branch: "main" });
    await expect(forge.defaultHead(REPO)).rejects.toMatchObject({ code: "upstream_failed" });
  });
});
