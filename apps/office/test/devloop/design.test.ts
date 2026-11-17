// 試作に進めた案の設計書を開発担当が書き、最初の設計書をオーナーが決める (開発の回し方の 3.1、3.2)
import { describe, expect, it } from "vitest";
import { stepUp } from "../helpers/github.ts";
import { api, idOf, rows, useWork } from "../helpers/work.ts";
import { DOCS, DOCS2, REPO, OTHER_APP, HEAD, NEXT, README, GOOD, failure, link, seedSetting, putDocs, studied, toPrototype, prototyped, designTasks, docsAt, pullOnGitHub, tool, takeDesign, openedDocsPull, reviewerApproves, events, mainMoves, pullsOpened, synchronize, linkedApp } from "../helpers/docs.ts";

const world = useWork({ github: true });

describe("決まった形の設計書", () => {
  it("設計書を書くタスク", async () => {
    await link(world);
    expect(await api(world, "GET", "/api/v1/devloop/docs-repo")).toEqual({ repo: null, version: 0 });
    expect(await putDocs(world, DOCS, 0)).toEqual({ repo: DOCS, version: 1 });
    expect(await api(world, "GET", "/api/v1/devloop/docs-repo")).toEqual({ repo: DOCS, version: 1 });

    const id = await studied(world);
    expect(await toPrototype(world, id)).toMatchObject({ stage: "prototype" });
    // 開発担当に、設計書のリポジトリへ書く 1 件のタスクが足される
    const [task, ...rest] = await designTasks(world);
    expect(rest).toEqual([]);
    expect(task).toMatchObject({ title: "設計書: 動画を作るサービス", assignee: "builder", task_kind: "build", repo: DOCS, scope: id, source: `design:${id}`, status: "todo" });
    expect(String(task?.["body"])).toContain("services/video-maker/");
    expect(String(task?.["body"])).toContain("WRITING.md");
    expect((await events(world, idOf(task)))[0]).toMatchObject({ kind: "created" });
  });

  it("設計書のリポジトリが無い", async () => {
    // GitHub とつなぐ前は、選べず 409
    await stepUp(world);
    expect(await putDocs(world, DOCS, 0, 409)).toMatchObject({ code: "conflict" });
    await link(world);
    const id = await studied(world);
    // 未設定なら試作に進めず 409。段階もタスクも変わらない
    expect(await toPrototype(world, id, REPO, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "study" }]);
    expect(await designTasks(world)).toEqual([]);

    // 公開のリポジトリ、触れる外、形の違う名前は 422
    for (const repo of [REPO, "example/elsewhere", "../x"]) expect(await putDocs(world, repo, 0, 422)).toMatchObject({ code: "validation_failed" });
    // 版違いは 409
    expect(await putDocs(world, DOCS, 5, 409)).toMatchObject({ code: "conflict" });
    // サービスのリポジトリは選べない
    await world.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(DOCS2, id).run();
    expect(await putDocs(world, DOCS2, 0, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "GET", "/api/v1/devloop/docs-repo")).toEqual({ repo: null, version: 0 });
    await world.d1.DB.prepare("UPDATE services SET repo = NULL WHERE id = ?").bind(id).run();

    // 選んだ後でも、触れるリポジトリから外れれば試作に進めず 409
    await putDocs(world, DOCS, 0);
    const installation = world.gate.github.installations.get(linkedApp().installationId);
    if (!installation) throw new Error("インストールが無い");
    const kept = installation.repos;
    installation.repos = kept.filter((r) => r !== DOCS);
    expect(await toPrototype(world, id, REPO, 409)).toMatchObject({ code: "conflict" });
    installation.repos = kept;
    expect(await toPrototype(world, id)).toMatchObject({ stage: "prototype" });

    // 後から設計書のリポジトリが公開のリポジトリに替わっていた時 (設定を直に置く) も、試作に進めず 409
    const second = await studied(world);
    await seedSetting(world, "devloop.docs_repo", { repo: REPO }, 2);
    expect(await toPrototype(world, second, OTHER_APP, 409)).toMatchObject({ code: "conflict" });
    // サービスのリポジトリと同じになっていた時 (サービスの行を直に直す) も 409
    await seedSetting(world, "devloop.docs_repo", { repo: DOCS }, 3);
    await world.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(DOCS, id).run();
    expect(await toPrototype(world, second, OTHER_APP, 409)).toMatchObject({ code: "conflict" });
    await world.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(REPO, id).run();

    // GitHub のルールの触れるリポジトリに入っていない時は、選べず (PUT は 422)、試作にも進めない (409)
    await seedSetting(world, "github.rules", { repos: [REPO, OTHER_APP] }, 1);
    expect(await putDocs(world, DOCS2, 3, 422)).toMatchObject({ code: "validation_failed" });
    expect(await toPrototype(world, second, OTHER_APP, 409)).toMatchObject({ code: "conflict" });
    expect(await designTasks(world)).toHaveLength(1);
  });

  it("形の違う設計書", async () => {
    // 要件の無い詳細設計。kind が app なので 04 と 05 の index.md も要る
    const bad = { ...GOOD, "services/video-maker/README.md": README.replace("kind: tool", "kind: app"), "services/video-maker/docs/04-detail/1-x.md": "# x\n\n## 1. 要件\n\nだけ\n" };
    const id = await prototyped(world);
    const task = await takeDesign(world, id);
    pullOnGitHub(world, Object.keys(bad));
    docsAt(world, HEAD, bad);
    // GitHub に出す前に 422 で断り、直す所を返す。PR は出さず、タスクは作業中のまま
    const refused = await failure(tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" }));
    expect(refused.code).toBe("validation_failed");
    expect(refused.errors?.map((e) => e.pointer)).toContain("#/files/docs/04-detail/1-x.md");
    expect(pullsOpened(world)).toBe(0);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);

    // 直せば出せる
    docsAt(world, HEAD, GOOD);
    pullOnGitHub(world, Object.keys(GOOD));
    expect(await tool(world, "builder", "pr_open", { name: "video-maker-docs", title: "t", body: "" })).toMatchObject({ isError: false });
    expect(pullsOpened(world)).toBe(1);
  });

  it("最初の設計書はオーナーが決める", async () => {
    const task = await openedDocsPull(world);
    // 既定のブランチに README が無い最初の設計書は、レビュー担当の承認だけでは入らない
    expect(await reviewerApproves(world)).toBe(false);
    expect(mainMoves(world)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    expect((await events(world, task)).find((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });

    // オーナーの承認がそろうと入る
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "設計書を読んだ", baseSha: HEAD });
    expect(mainMoves(world)).toEqual([{ sha: HEAD, force: false }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "done" }]);
  });

  it("設定で弱められない", async () => {
    // office の初期値の入れる条件を checks だけにしても、保護する道は office の初期値のままで、入れる条件は設計書の物
    await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'service.mergeWhen', 'office', ?, 1, 'owner', '弱める', 1)").bind(crypto.randomUUID(), JSON.stringify(["checks"])).run();
    const task = await openedDocsPull(world);
    expect(await reviewerApproves(world)).toBe(false);
    expect((await events(world, task)).find((e) => e.kind === "merge_waiting")).toEqual({ kind: "merge_waiting", detail: { reason: "owner" } });
    expect(mainMoves(world)).toEqual([]);

    // 入れる前に、触れない所を変える push があれば、設定に関わらず断る
    pullOnGitHub(world, [...Object.keys(GOOD), ".github/workflows/x.yml"]);
    await synchronize(world, DOCS, NEXT);
    docsAt(world, NEXT, GOOD);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "読んだ", baseSha: NEXT });
    expect(mainMoves(world)).toEqual([]);
    expect((await events(world, task)).some((e) => e.kind === "merge_refused")).toBe(true);
  });

});
