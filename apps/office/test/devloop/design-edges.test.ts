// 設計書を書くタスクと設計書の PR の、同時、設定の変わり、置き場の重なり、道と名前の境目 (開発の回し方の 3.2)
import { describe, expect, it } from "vitest";
import { wrapDb, stepUp } from "../helpers/github.ts";
import { api, rows, staffOf, useWork } from "../helpers/work.ts";
import { DOCS, DOCS2, REPO, BIG_NAME, HIDDEN, HEAD, NEXT, MAIN, README, GOOD, failure, link, putDocs, studied, toPrototype, prototyped, designTasks, docsAt, pullOnGitHub, tool, takeDesign, openedDocsPull, reviewerApproves, events, mainMoves, pullsOpened, synchronize } from "../helpers/docs.ts";

/**
 * 設計書のファイルを n 件 (GOOD の 2 件を含む) にする
 * @param n 件数
 * @returns 道と中身
 */
function many(n: number): Record<string, string> {
  return ({ ...GOOD, ...Object.fromEntries(Array.from({ length: n - 2 }, (_, i) => [`services/video-maker/docs/04-detail/${String(i + 1)}-f.md`, "# f\n\n## 1. 要件\n\n- **a**: b\n"])) });
}

const world = useWork({ github: true });

describe("設計書の PR と設計書を書くタスクの境目", () => {
  it("試作に進める同時の 2 回は、タスクも段階も 1 回だけ", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const id = await studied(world);
    const results = await Promise.all([toPrototype(world, id, REPO, 200).catch((e: unknown) => e), toPrototype(world, id, REPO, 409).catch((e: unknown) => e)]);
    expect(results).toHaveLength(2);
    expect(await designTasks(world)).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "prototype" }]);
  });

  it("試作に進める前に設計書のリポジトリの設定が変われば、段階もタスクも変わらない", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const id = await studied(world);
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        restore();
        await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'devloop.docs_repo', 'office', ?, 2, 'owner', '変える', 2)").bind(crypto.randomUUID(), JSON.stringify({ repo: DOCS2 })).run();
        return real(statements);
      },
    });
    expect(await toPrototype(world, id, REPO, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "study" }]);
    expect(await designTasks(world)).toEqual([]);
  });

  it("同じ名前のリポジトリを持つ別のサービスがあれば、試作に進めない", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const first = await studied(world);
    await toPrototype(world, first);
    const second = await studied(world);
    // 設計書の置き場 services/video-maker/ が重なる。名前は大文字小文字を分けない
    expect(await toPrototype(world, second, "example2/video-maker", 409)).toMatchObject({ code: "conflict" });
    expect(await designTasks(world)).toHaveLength(1);
  });

  it("設計書のリポジトリを後からサービスのリポジトリに選べない", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const id = await studied(world);
    // 試作に進める時の repo も、設定で変える repo も、今の設計書のリポジトリなら 409
    expect(await toPrototype(world, id, DOCS, 409)).toMatchObject({ code: "conflict" });
    await toPrototype(world, id);
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: DOCS, reason: "移す" }, 409)).toMatchObject({ code: "conflict" });
    // 大文字にした別の書き方でも同じ
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: DOCS.toUpperCase(), reason: "移す" }, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT repo FROM services WHERE id = ?", id)).toEqual([{ repo: REPO }]);
  });

  it("PR を出した後に形を壊す push は main に入らない", async () => {
    const task = await openedDocsPull(world);
    // 押された後の先は README を消している
    const broken = { "services/video-maker/docs/01-overview/index.md": "# 概要\n" };
    docsAt(world, NEXT, broken);
    pullOnGitHub(world, Object.keys(broken));
    await synchronize(world, DOCS, NEXT);
    // README が無いので最初の設計書と読めるが、形の外れが先に断る
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "読んだ", baseSha: NEXT });
    expect(await reviewerApproves(world, NEXT)).toBe(false);
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_refused")).toBe(true);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
  });

  it("設計書の PR の変えた道が空か外れていれば断る", async () => {
    const id = await prototyped(world);
    const task = await takeDesign(world, id);
    docsAt(world, HEAD, GOOD);
    // 変えた道が無い、services/<名前>/ の外、2 つのサービスにまたがる、形の違う名前は、PR を出す前に断る
    const cases: [string[], string][] = [
      [[], "validation_failed"],
      [["WRITING.md"], "validation_failed"],
      [["services/video-maker/README.md", "services/other/README.md"], "validation_failed"],
      [["services/video-maker/README.md", "README.md"], "validation_failed"],
      [["services/.hidden/README.md"], "validation_failed"],
      [["services/A_b/README.md"], "validation_failed"],
      [["services/../README.md"], "validation_failed"],
    ];
    for (const [changed, code] of cases) {
      pullOnGitHub(world, changed);
      expect((await failure(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" }))).code).toBe(code);
    }
    expect(pullsOpened(world)).toBe(0);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
  });

  it("設計書の木が切られたら 502 で、中身を読むファイルが 60 件を超えたら断る", async () => {
    const id = await prototyped(world);
    await takeDesign(world, id);
    pullOnGitHub(world, Object.keys(GOOD));
    // GitHub が木を切った (truncated) 時は、読み切れないので 502
    world.gate.github.set(`GET /repos/${DOCS}/git/trees/${HEAD}`, { sha: HEAD, tree: [], truncated: true });
    await expect(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).rejects.toMatchObject({ code: "upstream_failed" });
    // 60 件ちょうどは読み、61 件は読まずに断る
    docsAt(world, HEAD, many(61));
    await expect(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).rejects.toMatchObject({ code: "validation_failed" });
    expect(pullsOpened(world)).toBe(0);
    const contentReads = () => world.gate.github.requests.filter((r) => r.route.includes("/contents/")).length;
    const before = contentReads();
    docsAt(world, HEAD, many(60));
    expect(await tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).toMatchObject({ isError: false });
    expect(contentReads() - before).toBe(60);
  });

  it("最初の設計書の PR が services/README.md の一覧の行を足す", async () => {
    const id = await prototyped(world);
    await takeDesign(world, id);
    pullOnGitHub(world, [...Object.keys(GOOD), "services/README.md"]);
    docsAt(world, HEAD, GOOD);
    const list = "# サービス\n\n- [a](a/README.md)\n";
    const own = "- [video-maker](video-maker/README.md)\n";
    world.gate.github.contents.set(`${MAIN}:services/README.md`, list);
    const open = (next: string) => {
      world.gate.github.contents.set(`${HEAD}:services/README.md`, next);
      return tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" });
    };
    // ほかの行も変える、行を消す、自分の名前の無い行を足す、2 行足すは、PR を出す前に 422
    for (const next of [`# サービス!\n\n- [a](a/README.md)\n${own}`, `# サービス\n\n${own}`, `${list}- [x](x/README.md)\n`, `${list}${own}${own}`, list]) {
      const refused = await failure(open(next));
      expect(refused.code).toBe("validation_failed");
      expect(refused.errors?.map((e) => e.pointer)).toEqual(["#/files/services/README.md"]);
    }
    expect(pullsOpened(world)).toBe(0);
    // 自分の行をちょうど 1 行足すだけなら、末尾でも途中でも出せる
    expect(await open(`${list}${own}`)).toMatchObject({ isError: false });
    expect(pullsOpened(world)).toBe(1);
  });

  it("名前に大文字を含むリポジトリは小文字の置き場にし、置き場にできない名前は 422", async () => {
    await link(world);
    await putDocs(world, DOCS, 0);
    const big = await studied(world);
    expect(await toPrototype(world, big, BIG_NAME)).toMatchObject({ stage: "prototype" });
    const [task] = await designTasks(world);
    expect(String(task?.["body"])).toContain("services/big-name/");
    // 小文字にしても頭が英数字でない名前は、置き場にできない
    const hidden = await studied(world);
    expect(await toPrototype(world, hidden, HIDDEN, 422)).toMatchObject({ code: "validation_failed", errors: [{ pointer: "#/repo" }] });
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", hidden)).toEqual([{ stage: "study" }]);
  });

  it("設計書を書くタスクは、別のサービスの置き場を変えられない", async () => {
    const id = await prototyped(world);
    await takeDesign(world, id);
    // README の name も置き場も other の、形の合う設計書。このタスクは video-maker の置き場しか書けない
    const other = { "services/other/README.md": README.replace("name: video-maker", "name: other"), "services/other/docs/01-overview/index.md": "# 概要\n" };
    pullOnGitHub(world, Object.keys(other));
    docsAt(world, HEAD, other);
    const refused = await failure(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" }));
    expect(refused.code).toBe("validation_failed");
    expect(refused.errors?.map((e) => e.pointer)).toEqual(["#/files"]);
    expect(pullsOpened(world)).toBe(0);
  });

  it("設計書を書くタスクの PR が後から別のサービスの置き場だけを変えても、承認が出そろっても main が進まない", async () => {
    const task = await openedDocsPull(world);
    // 押された後の先は other の置き場だけを変える。形は合うが、このタスクは video-maker の置き場しか書けない
    const other = { "services/other/README.md": README.replace("name: video-maker", "name: other"), "services/other/docs/01-overview/index.md": "# 概要\n" };
    docsAt(world, NEXT, other);
    pullOnGitHub(world, Object.keys(other));
    await synchronize(world, DOCS, NEXT);
    expect(await reviewerApproves(world, NEXT)).toBe(false);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "読んだ", baseSha: NEXT });
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_refused")).toBe(true);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
  });

  it("README の読みが落ちたら最初かどうかを決めず、待たずに失敗にする", async () => {
    const task = await openedDocsPull(world);
    world.gate.github.failNext(`GET /repos/${DOCS}/contents/services/video-maker/README.md`, 500);
    await expect(reviewerApproves(world)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_waiting")).toBe(false);
  });

  it("既定のブランチに README があれば、チェックとレビュー担当の承認だけで入る", async () => {
    pullOnGitHub(world, []);
    world.gate.github.contents.set(`${MAIN}:services/video-maker/README.md`, README);
    const task = await openedDocsPull(world);
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world)).toEqual([{ sha: HEAD, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("設計書のリポジトリを別に変えた後の古いリポジトリは、普通のルールに戻る", async () => {
    const task = await openedDocsPull(world);
    await stepUp(world);
    await putDocs(world, DOCS2, 1);
    // 古い方は設計書の決まりを外れ、office の初期値のチェックとレビュー担当の承認だけで入る
    expect(await reviewerApproves(world)).toBe(true);
    expect(mainMoves(world)).toEqual([{ sha: HEAD, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("別の書き方のリポジトリ名でも差し替えを外せない", async () => {
    await link(world);
    // 大文字にした名前で選んでも、GitHub の名前で持つ。サービスのリポジトリにも同じ名前は選べない
    expect(await putDocs(world, DOCS.toUpperCase(), 0)).toEqual({ repo: DOCS, version: 1 });
    const id = await studied(world);
    expect(await toPrototype(world, id, DOCS.toUpperCase(), 409)).toMatchObject({ code: "conflict" });
    await world.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(DOCS2.toUpperCase(), id).run();
    expect(await putDocs(world, DOCS2, 1, 422)).toMatchObject({ code: "validation_failed" });
  });

  it("差し戻しの後に同じプルリクエストで出し直す設計書の PR も、変えた道が外れていれば断る", async () => {
    const task = await openedDocsPull(world);
    // レビュー担当が差し戻し、開発担当が同じタスクを取り直す
    await tool(world, "reviewer", "review_submit", { verdict: "reject", summary: "置き場を直す", headSha: HEAD });
    await staffOf(world, "builder").pull(world.clock.now());
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    // 直した先が services/<名前>/ の外を変えていれば、出し直しも GitHub に書かずに断る
    world.gate.github.files = [{ filename: "WRITING.md" }];
    expect((await failure(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" }))).code).toBe("validation_failed");
    expect(pullsOpened(world)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM nodes WHERE task_kind = 'review' AND status = 'todo'")).toEqual([{ n: 0 }]);
  });
});
