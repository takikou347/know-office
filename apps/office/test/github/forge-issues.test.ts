// GitHub を呼ぶ口の、設計書から作る Issue の読みと書き。一覧の頁の上限、プルリクエストの除外、書きの間の 1 秒、つなぎの 422 (開発の回し方の 3.3)
import { describe, expect, it } from "vitest";
import { createFakeGitHub } from "../../dev/github.ts";
import { httpForge } from "../../src/gate/github/forge.ts";

const BASE = "https://github.test";
const REPO = "example/svc";

/**
 * 代わりの GitHub に向けた httpForge を作る
 * @returns 呼ぶ口、代わりの GitHub、待った時間
 */
function forgeOnFake() {
  const github = createFakeGitHub();
  const pauses: number[] = [];
  const fetcher: Parameters<typeof httpForge>[1] = (url, init) => Promise.resolve(github.app.request(url.slice(BASE.length), init));
  const forge = httpForge(BASE, fetcher, { appId: 1, token: () => Promise.resolve("ghs_test") }, { pause: (ms) => Promise.resolve(void pauses.push(ms)) });
  return { github, forge, pauses };
}

describe("設計書から作る Issue を呼ぶ口", () => {
  it("一覧は開閉を問わず読み、プルリクエストを除き、新しい順に返す", async () => {
    const { github, forge } = forgeOnFake();
    github.issues.seed(REPO, { title: "a", body: "本文" });
    github.issues.seed(REPO, { title: "pr", pull: true });
    github.issues.seed(REPO, { title: "c", state: "closed" });
    expect((await forge.issues.listIssues(REPO)).map((i) => [i.number, i.state, i.body])).toEqual([
      [3, "closed", null],
      [1, "open", "本文"],
    ]);
    expect(github.requests.at(-1)?.route).toBe(`GET /repos/${REPO}/issues`);
  });

  it("一覧は 10 頁まで。1,000 件ちょうどは続きがあるとみて断り、999 件は読める", async () => {
    const { github, forge } = forgeOnFake();
    for (let i = 0; i < 999; i += 1) github.issues.seed(REPO, { title: String(i) });
    expect(await forge.issues.listIssues(REPO)).toHaveLength(999);
    github.issues.seed(REPO, { title: "1000" });
    await expect(forge.issues.listIssues(REPO)).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("書きは前の書きから 1 秒空ける。最初の書きは待たない", async () => {
    const { forge, pauses } = forgeOnFake();
    const parent = await forge.issues.createIssue(REPO, { title: "親", body: "b", labels: [] });
    const made = await forge.issues.createIssue(REPO, { title: "子", body: "b", labels: ["feature"] });
    await forge.issues.linkSubIssue(REPO, parent.number, made.id);
    await forge.issues.comment(REPO, made.number, "コメント");
    await forge.issues.closeNotPlanned(REPO, made.number);
    await forge.issues.reopen(REPO, made.number);
    expect(pauses).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it("つなぎが 422 の時は、親の子の一覧に子がいる時だけ成功とみなす", async () => {
    const { github, forge } = forgeOnFake();
    const parent = await forge.issues.createIssue(REPO, { title: "親", body: "b", labels: [] });
    const other = await forge.issues.createIssue(REPO, { title: "別の親", body: "b", labels: [] });
    const made = await forge.issues.createIssue(REPO, { title: "子", body: "b", labels: [] });
    await forge.issues.linkSubIssue(REPO, parent.number, made.id);
    await forge.issues.linkSubIssue(REPO, parent.number, made.id);
    await expect(forge.issues.linkSubIssue(REPO, other.number, made.id)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(github.issues.items.get(REPO)?.map((i) => i.parent)).toEqual([null, null, 1]);
  });

  it("閉じるコメントの有無は、目印を含むコメントを一覧から探す", async () => {
    const { forge } = forgeOnFake();
    const issue = await forge.issues.createIssue(REPO, { title: "子", body: "b", labels: [] });
    expect(await forge.issues.hasComment(REPO, issue.number, "<!-- m -->")).toBe(false);
    await forge.issues.comment(REPO, issue.number, "閉じる\n<!-- m -->");
    expect(await forge.issues.hasComment(REPO, issue.number, "<!-- m -->")).toBe(true);
  });
});
