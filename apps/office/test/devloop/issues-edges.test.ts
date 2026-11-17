// issue_plan の境目と落ち。段階、役、一覧の上限、途中で落ちた送り直し、同名の要件、閉じた親、作業中の子、古い pending (開発の回し方の 3.3)
import { describe, expect, it } from "vitest";
import { createFakeGitHub } from "../../dev/github.ts";
import { advance, MINUTE, rows, useWork } from "../helpers/work.ts";
import { buildTasks, callPlan, child, detail, devRows, issuesOf, pacedForge, plan, planFails, planOf, rewriteDocs, withDocs, REPO } from "../helpers/issues.ts";
import { devIssueKey, parseRequirements } from "@know-office/core";
import { z } from "zod";
import { devIssueMark } from "../../src/gate/findings/tracker.ts";

const world = useWork({ github: true });

/** 代わりの GitHub が返す Issue の番号と ID */
const Made = z.object({ number: z.number(), id: z.number() });

/** 機能 2 つに同じ名前の要件を持つ設計書 */
const TWO = { "1-video.md": detail(), "2-audio.md": ["# 詳細設計 2. 音声", "", "## 1. 要件", "", "- **動画を作る**: 音声の側の同じ名前", ""].join("\n") };

describe("issue_plan の呼べる所", () => {
  it("開発担当は呼べない", async () => {
    const id = await withDocs(world);
    expect(await planFails(world, planOf(id, [child("動画を作る")]), { staffId: "builder" })).toMatchObject({ code: "not_found" });
    expect(issuesOf(world)).toEqual([]);
  });

  it("サービスのリポジトリが無ければ 409", async () => {
    const id = await withDocs(world);
    await world.d1.DB.prepare("UPDATE services SET repo = NULL WHERE id = ?").bind(id).run();
    expect(await planFails(world, planOf(id, [child("動画を作る")]))).toMatchObject({ code: "conflict" });
  });

  it("サービスが無ければ 404", async () => {
    await withDocs(world);
    expect(await planFails(world, planOf("01900000-0000-7000-8000-0000000000ff", [child("動画を作る")]))).toMatchObject({ code: "not_found" });
  });

  it("機能のファイルが今の設計書に無ければ 422", async () => {
    const id = await withDocs(world);
    const error = await planFails(world, planOf(id, [child("動画を作る")], "9-none"));
    expect(error).toMatchObject({ code: "validation_failed", errors: [{ pointer: "#/parents/0/feature" }] });
    expect(issuesOf(world)).toEqual([]);
  });
});

describe("Issue の一覧の読み", () => {
  it("一覧を 10 ページで読み切れなければ、何も作らずに失敗する", async () => {
    const id = await withDocs(world);
    for (let i = 0; i < 1000; i += 1) world.gate.github.issues.seed(REPO, { title: `前からある ${String(i)}` });
    expect(await planFails(world, planOf(id, [child("動画を作る")]))).toMatchObject({ code: "upstream_failed" });
    expect(issuesOf(world)).toHaveLength(1000);
    expect(await devRows(world)).toEqual([]);
  });

  it("999 件なら 10 ページで読み切れて作れる。プルリクエストは Issue に数えない", async () => {
    const id = await withDocs(world);
    for (let i = 0; i < 998; i += 1) world.gate.github.issues.seed(REPO, { title: `前からある ${String(i)}` });
    world.gate.github.issues.seed(REPO, { title: "プルリクエスト", pull: true });
    const done = await plan(world, planOf(id, [child("動画を作る")]));
    expect(done.parents[0]?.number).toBe(1000);
  });

  it("本文に印のある Issue が前からあれば、作らずにそれを使う", async () => {
    const id = await withDocs(world);
    // 前に別の呼び出しが作って、行を書けなかった Issue。番号 1 の親
    const key = await devIssueKey({ serviceId: id, kind: "parent", feature: "1-video", requirement: null, hash: null });
    world.gate.github.issues.seed(REPO, { title: "動画", body: `設計書: 詳細設計 1-video の機能「動画」\n${devIssueMark(key)}` });
    const done = await plan(world, planOf(id, [child("動画を作る")]));
    expect(done.parents).toEqual([{ feature: "1-video", number: 1 }]);
    expect(issuesOf(world).filter((i) => i.title === "動画")).toHaveLength(1);
  });
});

describe("途中で落ちた時の送り直し", () => {
  it("途中で落ちて送り直すと残りだけ作る", async () => {
    const id = await withDocs(world, { "1-video.md": detail() });
    const gh = world.gate.github;
    let writes = 0;
    // 3 つ目の書き (子 1 件目の作成の後、2 件目の作成) で GitHub が失敗する
    const failing = pacedForge(world, () => {
      writes += 1;
      if (writes === 3) gh.failNext(`POST /repos/${REPO}/issues`, 500);
    });
    await expect(callPlan(world, planOf(id, [child("動画を作る"), child("動画を見る")]), { forge: failing })).rejects.toMatchObject({ code: "upstream_failed" });
    expect(issuesOf(world).map((i) => i.title)).toEqual(["動画", "動画を作る"]);
    // 失敗した子は pending が残る。2 分を過ぎて送り直すと、残りの 1 件だけを作る
    await advance(world, world.clock.now() + 3 * MINUTE);
    const next = await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    expect(next.children.map((c) => c.created)).toEqual([false, true]);
    expect(issuesOf(world).map((i) => i.title)).toEqual(["動画", "動画を作る", "動画を見る"]);
    expect((await devRows(world)).map((r) => r["state"])).toEqual(["open", "open", "open"]);
  });

  it("つなぐ前に落ちた子は、送り直しで同じ Issue を見つけてつなぐ", async () => {
    const id = await withDocs(world);
    world.gate.github.failNext(`POST /repos/${REPO}/issues/1/sub_issues`, 500);
    await expect(callPlan(world, planOf(id, [child("動画を作る")]))).rejects.toMatchObject({ code: "upstream_failed" });
    expect(issuesOf(world).map((i) => [i.title, i.parent])).toEqual([["動画", null], ["動画を作る", null]]);
    await advance(world, world.clock.now() + 3 * MINUTE);
    const next = await plan(world, planOf(id, [child("動画を作る")]));
    expect(issuesOf(world).map((i) => [i.title, i.parent])).toEqual([["動画", null], ["動画を作る", 1]]);
    expect(next.children).toMatchObject([{ number: 2 }]);
    expect(await buildTasks(world)).toHaveLength(1);
  });

  it("GitHub がつなぎを 422 で断っても、すでにその親の子なら成功とみなす", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る")]));
    // 行を pending に戻して、つなぎ済みの子をもう一度つなぐ。GitHub は同じ親への 2 度目を 422 で断る
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'pending', number = NULL WHERE requirement = '動画を作る'").run();
    await advance(world, world.clock.now() + 3 * MINUTE);
    await plan(world, planOf(id, [child("動画を作る")]));
    expect(world.gate.github.issues.writes.filter((r) => r.endsWith("/sub_issues"))).toHaveLength(2);
    expect((await devRows(world))[1]).toMatchObject({ state: "open", number: 2 });
  });

  it("別の親につながっている子の 422 は成功とみなさず、失敗にする", async () => {
    const id = await withDocs(world);
    const other = world.gate.github.issues.seed(REPO, { title: "別の親" });
    const key = await devIssueKey({ serviceId: id, kind: "parent", feature: "1-video", requirement: null, hash: null });
    const hash = (await parseRequirements(detail()))[0]?.hash ?? "";
    const childKey = await devIssueKey({ serviceId: id, kind: "child", feature: "1-video", requirement: "動画を作る", hash });
    world.gate.github.issues.seed(REPO, { title: "動画", body: devIssueMark(key) });
    const orphan = world.gate.github.issues.seed(REPO, { title: "動画を作る", body: devIssueMark(childKey), parent: other.number });
    expect(orphan.parent).toBe(other.number);
    await expect(callPlan(world, planOf(id, [child("動画を作る")]))).rejects.toMatchObject({ code: "upstream_failed" });
    expect(orphan.parent).toBe(other.number);
  });
});

/**
 * 要件の名前を並べた詳細設計を作る
 * @param list 要件の名前
 * @returns 詳細設計の本文
 */
function many(list: string[]): string {
  return ["# 詳細設計 1. 動画", "", "## 1. 要件", "", ...list.map((n) => `- **${n}**: 本文`), ""].join("\n");
}

/**
 * 親の pending の行を置く
 * @param id サービス ID
 * @param createdAt 作った時刻
 */
async function pendingParent(id: string, createdAt: number): Promise<void> {
  const key = await devIssueKey({ serviceId: id, kind: "parent", feature: "1-video", requirement: null, hash: null });
  await world.d1.DB.prepare("INSERT INTO dev_issues (id, service_id, repo, kind, feature, mark_key, state, created_at) VALUES (?, ?, ?, 'parent', '1-video', ?, 'pending', ?)").bind(crypto.randomUUID(), id, REPO, key, createdAt).run();
}

describe("pending の行", () => {
  it("pending が古ければ引き取る", async () => {
    const id = await withDocs(world);
    await pendingParent(id, world.clock.now() - 2 * MINUTE - 1);
    const done = await plan(world, planOf(id, [child("動画を作る")]));
    expect(done.parents).toEqual([{ feature: "1-video", number: 1 }]);
    expect((await devRows(world))[0]).toMatchObject({ kind: "parent", state: "open" });
  });

  it("pending が新しければ 409", async () => {
    const id = await withDocs(world);
    // ちょうど 2 分は、まだ新しい。1 ミリ秒過ぎたら古い
    await pendingParent(id, world.clock.now() - 2 * MINUTE);
    expect(await planFails(world, planOf(id, [child("動画を作る")]))).toMatchObject({ code: "conflict" });
    expect(issuesOf(world)).toEqual([]);
  });
});

describe("同名の要件、閉じた親、作業中の子", () => {
  it("同名の要件が別の機能にあっても、別々の子になる。消えるのは機能ごと", async () => {
    const id = await withDocs(world, TWO);
    const input = { serviceId: id, parents: [{ feature: "1-video", children: [child("動画を作る")] }, { feature: "2-audio", children: [child("動画を作る")] }] };
    const done = await plan(world, input);
    expect(done.children.map((c) => [c.feature, c.created])).toEqual([["1-video", true], ["2-audio", true]]);
    expect(issuesOf(world).map((i) => i.title)).toEqual(["動画", "動画を作る", "音声", "動画を作る"]);
    // 2-audio からだけ消える
    rewriteDocs(world, "2-audio.md", "# 詳細設計 2. 音声\n\n## 1. 要件\n\n- **別の要件**: 本文\n");
    const next = await plan(world, { serviceId: id, parents: [{ feature: "2-audio", children: [child("別の要件")] }] });
    expect(next.closed).toEqual([4]);
    expect(issuesOf(world)[1]?.state).toBe("open");
    expect(issuesOf(world)[3]?.state).toBe("closed");
  });

  it("閉じた親に新しい子を付ける時は、親を開き直す", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る")]));
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed' WHERE kind = 'parent'").run();
    const parent = issuesOf(world)[0];
    if (parent) parent.state = "closed";
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    expect(issuesOf(world)[0]).toMatchObject({ state: "open", stateReason: "reopened" });
    expect((await devRows(world))[0]).toMatchObject({ kind: "parent", state: "open" });
    expect(issuesOf(world)[2]?.parent).toBe(1);
  });

  it("作業中 (doing と review) の子は閉じず、社長に知らせるだけにする", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    await world.d1.DB.prepare("UPDATE nodes SET status = 'doing' WHERE source = 'issue:2'").run();
    await world.d1.DB.prepare("UPDATE nodes SET status = 'review' WHERE source = 'issue:3'").run();
    rewriteDocs(world, "1-video.md", detail({ first: "変えた本文", second: null }));
    const next = await plan(world, planOf(id, [child("動画を作る")]));
    // 動画を見る は消えたが review 中、動画を作る は置き換わったが doing 中
    expect(next.closed).toEqual([]);
    expect(next.running.toSorted((a, b) => a - b)).toEqual([2, 3]);
    expect(issuesOf(world).map((i) => i.state)).toEqual(["open", "open", "open", "open"]);
    expect((await buildTasks(world)).map((t) => t["status"])).toEqual(["doing", "review", "todo"]);
  });

  it("消えた機能のファイルの子は、子 0 件の親を送ると閉じる。無い機能に子も無ければ断る", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    await world.d1.DB.prepare("UPDATE nodes SET status = 'doing' WHERE source = 'issue:3'").run();
    rewriteDocs(world, "1-video.md", null);
    // 機能のファイルが無いのに子を送れば、今までどおり断る
    expect(await planFails(world, planOf(id, [child("動画を作る")]))).toMatchObject({ code: "validation_failed" });
    const next = await plan(world, planOf(id, []));
    expect(next.closed).toEqual([2]);
    expect(next.running).toEqual([3]);
    expect(next.parents).toEqual([]);
    expect(issuesOf(world).map((i) => i.state)).toEqual(["open", "closed", "open"]);
    expect(issuesOf(world)[1]?.comments).toHaveLength(1);
    // 閉じる子も無い機能は、書き間違いとして断る
    expect(await planFails(world, planOf(id, [], "9-none"))).toMatchObject({ code: "validation_failed" });
  });

  it("閉じるコメントの二重を作らない", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    // 閉じるコメントを書いた後、閉じる前に落ちた状態を作る
    const [row] = await rows(world.d1.DB, "SELECT mark_key FROM dev_issues WHERE requirement = '動画を見る'");
    issuesOf(world)[2]?.comments.push({ id: 1, body: `設計書から外れたので閉じる\n${devIssueMark(String(row?.["mark_key"]))}` });
    rewriteDocs(world, "1-video.md", detail({ second: null }));
    const next = await plan(world, planOf(id, [child("動画を作る")]));
    expect(next.closed).toEqual([3]);
    expect(issuesOf(world)[2]?.comments).toHaveLength(1);
    expect(issuesOf(world)[2]?.state).toBe("closed");
  });

  it("閉じる子は 1 回に 10 件までで、残りは more で知らせる", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `要件 ${String(i)}`);
    const id = await withDocs(world, { "1-video.md": many([...names, "残る"]) });
    await plan(world, planOf(id, names.map((n) => child(n))));
    // 11 件目を足してから、10 件を消す。閉じるのは 10 件までで 11 件消せば more
    const extra = world.gate.github.issues.seed(REPO, { title: "余り" });
    await world.d1.DB.prepare("INSERT INTO dev_issues (id, service_id, repo, number, issue_id, parent_number, kind, feature, requirement, req_hash, issue_kind, paths, mark_key, state, created_at) VALUES (?, ?, ?, ?, ?, 1, 'child', '1-video', '余り', 'x', 'feature', '[]', ?, 'open', 0)").bind(crypto.randomUUID(), id, REPO, extra.number, extra.id, "e".repeat(64)).run();
    rewriteDocs(world, "1-video.md", many(["残る"]));
    const next = await plan(world, planOf(id, [child("残る")]));
    expect(next.closed).toHaveLength(10);
    expect(next.more).toBe(true);
    // 残りは次の issue_plan で閉じる
    const last = await plan(world, planOf(id, [child("残る")]));
    expect(last.closed.length + next.closed.length).toBe(11);
  });
});

describe("代わりの GitHub の決まり", () => {
  it("sub_issue_id は番号でなく ID で、1 つの親に 100 件まで、1 分に 80 件を超える書きは 403 で断る", async () => {
    const github = createFakeGitHub();
    const call = (method: string, path: string, body?: unknown) => github.app.request(`/repos/example/r${path}`, { method, headers: { authorization: "Bearer ghs_test", "user-agent": "t", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parent = Made.parse(await (await call("POST", "/issues", { title: "親" })).json());
    const first = Made.parse(await (await call("POST", "/issues", { title: "子" })).json());
    // 番号を渡しても、同じ番号の ID は無い
    expect((await call("POST", `/issues/${String(parent.number)}/sub_issues`, { sub_issue_id: first.number })).status).toBe(404);
    expect((await call("POST", `/issues/${String(parent.number)}/sub_issues`, { sub_issue_id: first.id })).status).toBe(201);
    expect((await call("POST", `/issues/${String(parent.number)}/sub_issues`, { sub_issue_id: first.id })).status).toBe(422);
    for (let i = 0; i < 76; i += 1) await call("POST", "/issues", { title: `n${String(i)}` });
    // ここまで 親、子、つなぎ、76 件で 80 件。81 件目は断る
    const over = await call("POST", "/issues", { title: "81" });
    expect(over.status).toBe(403);
    expect(over.headers.get("retry-after")).toBe("60");
  });
});
