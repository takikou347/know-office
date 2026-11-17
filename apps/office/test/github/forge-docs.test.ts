// GitHub を呼ぶ口の、設計書の確かめに使う branchHead と listFiles。ブランチの先を 1 つのコミットに固定し、その木から prefix の下のファイルを返す (開発の回し方の 3.2)
import { describe, expect, it } from "vitest";
import { createFakeGitHub } from "../../dev/github.ts";
import { httpForge } from "../../src/gate/github/forge.ts";

const BASE = "https://github.test";
const REPO = "example/knowidea-docs";
const SHA = "c".repeat(40);

/**
 * 代わりの GitHub に向けた httpForge を作る
 * @returns 呼ぶ口と、代わりの GitHub
 */
function forgeOnFake() {
  const github = createFakeGitHub();
  const fetcher: Parameters<typeof httpForge>[1] = (url, init) => Promise.resolve(github.app.request(url.slice(BASE.length), init));
  return { github, forge: httpForge(BASE, fetcher, { appId: 1, token: () => Promise.resolve("ghs_test") }) };
}

const entry = (path: string, type = "blob") => ({ path, mode: "100644", type, sha: "1".repeat(40) });

describe("設計書の確かめに使う読み", () => {
  it("ブランチの先は、/ を残して符号にした ref を読み、コミットを返す", async () => {
    const { github, forge } = forgeOnFake();
    github.set(`GET /repos/${REPO}/git/ref/heads/ko/ab12-docs%2Bx`, { ref: "refs/heads/ko/ab12-docs+x", object: { sha: SHA } });
    expect(await forge.branchHead(REPO, "ko/ab12-docs+x")).toBe(SHA);
    github.set(`GET /repos/${REPO}/git/ref/heads/ko/bad`, { ref: "refs/heads/ko/bad", object: { sha: "../x" } });
    await expect(forge.branchHead(REPO, "ko/bad")).rejects.toMatchObject({ code: "upstream_failed" });
    await expect(forge.branchHead(REPO, "ko/../x")).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("木から prefix の下のファイルだけを返し、フォルダは返さない", async () => {
    const { github, forge } = forgeOnFake();
    github.set(`GET /repos/${REPO}/git/trees/${SHA}`, { sha: SHA, tree: [entry("README.md"), entry("services/a", "tree"), entry("services/a/README.md"), entry("services/ab/README.md"), entry("services/a/docs/01-overview/index.md")], truncated: false });
    expect(await forge.listFiles(REPO, SHA, "services/a/")).toEqual(["services/a/README.md", "services/a/docs/01-overview/index.md"]);
    // ref はコミットの形だけを道に入れる
    await expect(forge.listFiles(REPO, "../x", "services/a/")).rejects.toMatchObject({ code: "internal" });
  });

  it("GitHub が木を切った時と、500 件を超えた時は null を返す", async () => {
    const { github, forge } = forgeOnFake();
    github.set(`GET /repos/${REPO}/git/trees/${SHA}`, { sha: SHA, tree: [entry("services/a/README.md")], truncated: true });
    expect(await forge.listFiles(REPO, SHA, "services/a/")).toBeNull();
    const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`services/a/docs/${String(i)}.md`));
    github.set(`GET /repos/${REPO}/git/trees/${SHA}`, { sha: SHA, tree: many(500), truncated: false });
    expect(await forge.listFiles(REPO, SHA, "services/a/")).toHaveLength(500);
    github.set(`GET /repos/${REPO}/git/trees/${SHA}`, { sha: SHA, tree: many(501), truncated: false });
    expect(await forge.listFiles(REPO, SHA, "services/a/")).toBeNull();
  });
});
