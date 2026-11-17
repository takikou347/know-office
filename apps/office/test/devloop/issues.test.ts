// 設計書から Issue を作る (開発の回し方の 3.3、3.4)。社長の issue_plan が、設計書の前には作らず、親と子を決まった形で作り、sub-issue でつなぎ、子ごとに開発担当のタスクを足す
import { AppError } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { advance, useWork } from "../helpers/work.ts";
import { MINUTE, rows } from "../helpers/work.ts";
import { buildTasks, callPlan, child, detail, devRows, issuesOf, pacedForge, plan, planFails, planOf, rewriteDocs, withDocs, REPO } from "../helpers/issues.ts";
import { prototyped } from "../helpers/docs.ts";
import { wrapDb } from "../helpers/github.ts";

const world = useWork({ github: true });

describe("決まった形の設計書", () => {
  it("設計書の前に開発のタスクを作らない", async () => {
    // 試作に進めたが、設計書のリポジトリの main にサービスの README.md がまだ無い
    const id = await prototyped(world);
    const error = await planFails(world, planOf(id, [child("動画を作る")]));
    expect(error).toMatchObject({ code: "conflict" });
    expect(issuesOf(world)).toEqual([]);
    expect(await buildTasks(world)).toEqual([]);
    expect(await devRows(world)).toEqual([]);
  });
});

describe("設計書から Issue を作る", () => {
  it("親と子の Issue", async () => {
    const id = await withDocs(world);
    const pauses: number[] = [];
    const answer = await plan(world, planOf(id, [child("動画を作る"), child("動画を見る", { kind: "bug", priority: "high" })]), pacedForge(world, (ms) => pauses.push(ms)));
    // 親、子 2 件の順に作り、子は親に sub-issue でつながる
    const issues = issuesOf(world);
    expect(issues.map((i) => i.title)).toEqual(["動画", "動画を作る", "動画を見る"]);
    expect(issues.map((i) => i.parent)).toEqual([null, 1, 1]);
    expect(issues.map((i) => i.labels)).toEqual([[], ["feature"], ["bug", "priority: high"]]);
    expect(answer).toMatchObject({ parents: [{ feature: "1-video", number: 1 }], children: [{ requirement: "動画を作る", number: 2, created: true }, { requirement: "動画を見る", number: 3, created: true }], closed: [], running: [] });
    // 本文は設計書の章の名前と済みの条件の 2 行と、隠した印だけ
    for (const i of issues) expect(i.body).toMatch(/^設計書: 詳細設計 1-video の(機能「動画」|要件「動画を(作る|見る)」)\n済みの条件: .+\n<!-- know-office:dev-issue:[\da-f]{64} -->$/);
    // 書きは 1 秒ずつ空ける。作成 3 件とつなぎ 2 件の 5 回の書きの間の 4 回
    expect(pauses).toEqual([1000, 1000, 1000, 1000]);
    expect(await devRows(world)).toMatchObject([
      { kind: "parent", feature: "1-video", number: 1, parent_number: null, state: "open" },
      { kind: "child", requirement: "動画を作る", number: 2, parent_number: 1, state: "open", issue_kind: "feature" },
      { kind: "child", requirement: "動画を見る", number: 3, parent_number: 1, state: "open", issue_kind: "bug" },
    ]);
    // 子ごとに開発担当のタスク。優先度 high は 1
    const tasks = await buildTasks(world);
    expect(tasks).toMatchObject([
      { source: "issue:2", assignee: "builder", repo: REPO, scope: id, task_kind: "build", status: "todo", priority: 100 },
      { source: "issue:3", assignee: "builder", repo: REPO, scope: id, task_kind: "fix", status: "todo", priority: 1 },
    ]);
    // 同じ入力をもう一度送っても、作らずに今の物を返す
    const again = await plan(world, planOf(id, [child("動画を作る"), child("動画を見る", { kind: "bug", priority: "high" })]));
    expect(again.children.map((c) => c.created)).toEqual([false, false]);
    expect(issuesOf(world)).toHaveLength(3);
    expect(await buildTasks(world)).toHaveLength(2);
  });

  it("決まっていないラベル", async () => {
    const id = await withDocs(world);
    for (const bad of [{ kind: "wontfix" }, { priority: "urgent" }, { labels: ["wontfix"] }]) {
      expect(await planFails(world, planOf(id, [child("動画を作る", bad)]))).toMatchObject({ code: "validation_failed" });
    }
    expect(issuesOf(world)).toEqual([]);
    expect(await devRows(world)).toEqual([]);
  });

  it("閉じた要件を作り直さない", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    // 子 Issue が閉じ、ほかの要件の本文だけが変わった設計書が入る
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed' WHERE requirement = '動画を作る'").run();
    const closed = issuesOf(world)[1];
    if (closed) closed.state = "closed";
    rewriteDocs(world, "1-video.md", detail({ second: "台本から探す" }));
    const next = await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    // 閉じた子は作り直さない。本文が変わった子は 4 つ目の Issue になる
    expect(next.children).toMatchObject([{ requirement: "動画を作る", number: 2, created: false }, { requirement: "動画を見る", number: 4, created: true }]);
    expect(issuesOf(world).filter((i) => i.title === "動画を作る")).toHaveLength(1);
    expect(issuesOf(world)[1]?.state).toBe("closed");
  });

  it("本文が変わった要件", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る")]));
    rewriteDocs(world, "1-video.md", detail({ first: "台本から作る" }));
    const next = await plan(world, planOf(id, [child("動画を作る")]));
    // 新しい子 Issue ができ、置き換わった古い開いた子は決まった文で not_planned に閉じ、todo のタスクは取り消す
    expect(next.children).toMatchObject([{ requirement: "動画を作る", number: 3, created: true }]);
    expect(next.closed).toEqual([2]);
    const old = issuesOf(world)[1];
    expect(old).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(old?.comments.map((c) => c.body.split("\n")[0])).toEqual(["設計書の変更で置き換わったので閉じる"]);
    expect(await buildTasks(world)).toMatchObject([{ source: "issue:2", status: "dropped" }, { source: "issue:3", status: "todo" }]);
    expect(await devRows(world)).toMatchObject([{ kind: "parent" }, { number: 2, state: "closed" }, { number: 3, state: "open" }]);

    // 閉じた子の要件の本文が変わると新しい子ができ、閉じた子にはコメントを書かず閉じたまま
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed' WHERE number = 3").run();
    const done = issuesOf(world)[2];
    if (done) done.state = "closed";
    rewriteDocs(world, "1-video.md", detail({ first: "絵から作る" }));
    const again = await plan(world, planOf(id, [child("動画を作る")]));
    expect(again.children).toMatchObject([{ requirement: "動画を作る", number: 4, created: true }]);
    expect(again.closed).toEqual([]);
    expect(issuesOf(world)[2]).toMatchObject({ state: "closed", comments: [] });
  });

  it("消えた要件", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    rewriteDocs(world, "1-video.md", detail({ second: null }));
    const next = await plan(world, planOf(id, [child("動画を作る")]));
    expect(next.closed).toEqual([3]);
    expect(issuesOf(world)[2]).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(issuesOf(world)[2]?.comments.map((c) => c.body.split("\n")[0])).toEqual(["設計書から外れたので閉じる"]);
    expect(await buildTasks(world)).toMatchObject([{ source: "issue:2", status: "todo" }, { source: "issue:3", status: "dropped" }]);
    // 残った要件の子は開いたまま
    expect(issuesOf(world)[1]?.state).toBe("open");
  });

  it("1 回に 10 件まで", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `要件 ${String(i)}`);
    const id = await withDocs(world, { "1-video.md": ["# 詳細設計 1. 動画", "", "## 1. 要件", "", ...names.map((n) => `- **${n}**: 本文`), ""].join("\n") });
    expect(await planFails(world, planOf(id, names.map((n) => child(n))))).toMatchObject({ code: "validation_failed" });
    expect(issuesOf(world)).toEqual([]);
    // 10 件は親と合わせて 11 件の Issue になる
    const ten = await plan(world, planOf(id, names.slice(0, 10).map((n) => child(n))));
    expect(ten.children).toHaveLength(10);
    expect(issuesOf(world)).toHaveLength(11);
    // 超えた分は次の issue_plan で送る
    const rest = await plan(world, planOf(id, [child(names[10] ?? "")]));
    expect(rest.children).toMatchObject([{ created: true, number: 12 }]);
  });

  it("公開の Issue に設計を書かない", async () => {
    const id = await withDocs(world, { "1-video.md": detail({ first: "合言葉 sk-ant-abc123 を使って文章から作る https://example.com/doc" }) });
    await plan(world, planOf(id, [child("動画を作る", { paths: ["src/secret-path.ts"] })]));
    const text = JSON.stringify(issuesOf(world));
    // 要件の本文、触るファイル、設計書の URL とリポジトリは Issue に出ない
    for (const leaked of ["sk-ant", "文章から作る", "example.com", "secret-path", "knowidea-docs", "services/video-maker"]) expect(text).not.toContain(leaked);
    // 社員が自由に書ける欄は無い。題と本文を送ろうとしても入力の形で断る
    expect(await planFails(world, { ...planOf(id, [child("動画を見る")]), title: "自由な題" })).toMatchObject({ code: "validation_failed" });
    expect(await planFails(world, planOf(id, [child("動画を見る", { body: "自由な本文" })]))).toMatchObject({ code: "validation_failed" });
    // 設計書に無い要件の名前は 422 で、Issue は作らない
    const before = issuesOf(world).length;
    const missing = await planFails(world, planOf(id, [child("設計書に無い要件")]));
    expect(missing).toMatchObject({ code: "validation_failed", errors: [{ pointer: "#/parents/0/children/0/requirement" }] });
    expect(issuesOf(world)).toHaveLength(before);
  });

  it("伏せる形の名前は要件にできない", async () => {
    const id = await withDocs(world, { "1-video.md": ["# 詳細設計 1. 動画", "", "## 1. 要件", "", "- **a@example.com に送る**: 本文", ""].join("\n") });
    const error = await planFails(world, planOf(id, [child("a@example.com に送る")]));
    expect(error).toMatchObject({ code: "validation_failed", errors: [{ pointer: "#/parents/0/children/0/requirement" }] });
    expect(issuesOf(world)).toEqual([]);
  });
});

describe("Issue を作る間の落ちと同時", () => {
  it("Issue を作れた後に記録を書けず送り直しても Issue を 2 つ作らない", async () => {
    const id = await withDocs(world);
    // 親の Issue を作った後の行の書きで落とす
    const restore = wrapDb(world, {
      batch: () => {
        restore();
        return Promise.reject(new Error("落ちた"));
      },
    });
    await expect(callPlan(world, planOf(id, [child("動画を作る")]))).rejects.toThrow("落ちた");
    expect(issuesOf(world)).toHaveLength(1);
    expect(await devRows(world)).toMatchObject([{ kind: "parent", state: "pending" }]);
    // pending が新しければ別の呼び出しが作っているとみて 409
    expect(await planFails(world, planOf(id, [child("動画を作る")]))).toMatchObject({ code: "conflict" });
    // 2 分を過ぎたら引き取り、印で見つけた Issue を使う。親は 1 つのまま
    await advance(world, world.clock.now() + 3 * MINUTE);
    const next = await plan(world, planOf(id, [child("動画を作る")]));
    expect(issuesOf(world).map((i) => i.title)).toEqual(["動画", "動画を作る"]);
    expect(next.parents).toEqual([{ feature: "1-video", number: 1 }]);
    expect((await devRows(world)).map((r) => r["state"])).toEqual(["open", "open"]);
  });

  it("同時の 2 回は Issue を 1 つずつしか作らない", async () => {
    const id = await withDocs(world);
    const results = await Promise.allSettled([callPlan(world, planOf(id, [child("動画を作る")])), callPlan(world, planOf(id, [child("動画を作る")]))]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    // 落ちた側は conflict だけ
    const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    expect(failed.filter((e) => !(e instanceof AppError) || e.code !== "conflict")).toEqual([]);
    expect(issuesOf(world).filter((i) => i.title === "動画")).toHaveLength(1);
    expect(issuesOf(world).filter((i) => i.title === "動画を作る")).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM nodes WHERE source LIKE 'issue:%'")).toEqual([{ n: 1 }]);
  });
});

describe("段階の確かめ", () => {
  it("検討の段階のサービスには作らない", async () => {
    // リポジトリと設計書がそろっていても、検討に戻したサービスには作らない
    const id = await withDocs(world);
    await world.d1.DB.prepare("UPDATE services SET stage = 'study' WHERE id = ?").bind(id).run();
    expect(await planFails(world, planOf(id, [child("動画を作る")]))).toMatchObject({ code: "conflict" });
    expect(issuesOf(world)).toEqual([]);
    expect(await devRows(world)).toEqual([]);
  });
});
