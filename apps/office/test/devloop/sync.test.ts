// 設計書のリポジトリの push から Issue を合わせるタスクを足す所と、ゲートウェイが作った Issue の通知の扱い (開発の回し方の 3.3)
import { describe, expect, it } from "vitest";
import { hook } from "../helpers/github.ts";
import { linkedApp, NEXT, MAIN } from "../helpers/docs.ts";
import { BASE, child, detail, devRows, issuesOf, plan, planOf, withDocs, DOCS, REPO } from "../helpers/issues.ts";
import { rows, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });

const FEATURE = `${BASE}/1-video.md`;

/**
 * 設計書のリポジトリへの push を送る
 * @param change push の内容
 * @param change.ref ref
 * @param change.after 新しい先
 * @param change.commits 並べるコミット
 * @param change.repo リポジトリ
 */
async function pushDocs(change: { ref?: string; after?: string; commits?: unknown[]; repo?: string } = {}): Promise<void> {
  const app = linkedApp();
  const payload = {
    ref: change.ref ?? "refs/heads/main",
    after: change.after ?? NEXT,
    repository: { full_name: change.repo ?? DOCS, default_branch: "main" },
    commits: change.commits ?? [{ modified: [FEATURE] }],
    installation: { id: app.installationId },
  };
  expect((await hook(world, { event: "push", payload, secret: app.webhookSecret })).status).toBe(204);
}

/** @returns 試作のサービスの、社長の Issue を合わせるタスク。マイグレーションが置いた別のサービスの物は読まない */
async function syncTasks(): Promise<Record<string, unknown>[]> {
  const [service] = await rows(world.d1.DB, "SELECT id FROM services WHERE repo = ?", REPO);
  return rows(world.d1.DB, "SELECT title, body, assignee, task_kind, scope, source, status FROM nodes WHERE source = ? ORDER BY rowid", `issue-sync:${String(service?.["id"])}`);
}

/**
 * 機能のファイルを n 件並べた木を作る
 * @param n 件数
 * @returns 木の項目
 */
function featureTree(n: number): { path: string; mode: string; type: string; sha: string }[] {
  return Array.from({ length: n }, (_, i) => ({ path: `${BASE}/${String(i + 1)}-f.md`, mode: "100644", type: "blob", sha: "1".repeat(40) }));
}

/**
 * Issue を開いた通知を送る
 * @param issue 番号、題、本文
 * @param issue.number 番号
 * @param issue.title 題
 * @param issue.body 本文
 * @param event 通知の種類
 * @param sender 送った者の種類
 */
async function issueEvent(issue: { number: number; title: string; body: string }, event = "issues", sender = "User"): Promise<void> {
  const app = linkedApp();
  const payload = { action: event === "issues" ? "opened" : "created", issue, comment: { body: "コメント" }, sender: { type: sender }, repository: { full_name: REPO }, installation: { id: app.installationId } };
  expect((await hook(world, { event, payload, secret: app.webhookSecret })).status).toBe(204);
}

/** @returns 社長の分けるタスク (Issue から) */
function intakeTasks(): Promise<Record<string, unknown>[]> {
  return rows(world.d1.DB, "SELECT title, source, issue_number FROM nodes WHERE source = 'issue'");
}

describe("Issue を合わせるタスク", () => {
  it("設計書が main で変わると社長に合わせるタスクが 1 つだけ足される", async () => {
    const id = await withDocs(world);
    await pushDocs();
    // 同じサービスの todo があれば、2 度目の push は足さない
    await pushDocs({ after: MAIN });
    const tasks = await syncTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignee: "president", task_kind: "plan", scope: id, source: `issue-sync:${id}`, status: "todo" });
    const body = String(tasks[0]?.["body"]);
    // 今の設計書と dev_issues を比べた一覧と、比べたコミット、一覧は参考である事
    expect(body).toContain("足した要件: 1-video 動画を作る、1-video 動画を見る");
    expect(body).toContain("本文が変わった要件: なし");
    expect(body).toContain("消えた要件: なし");
    expect(body).toContain(NEXT);
    expect(body).toContain("この一覧は参考で、issue_plan が今のコミットで確かめる");
  });

  it("関わらない道の push では足さない", async () => {
    await withDocs(world);
    await pushDocs({ commits: [{ modified: ["services/video-maker/docs/02-architecture/index.md"] }] });
    await pushDocs({ after: MAIN, commits: [{ modified: ["services/other/docs/04-detail/1-x.md"] }] });
    await pushDocs({ after: "e".repeat(40), ref: "refs/heads/ko/x" });
    await pushDocs({ after: "f".repeat(40), commits: [] });
    expect(await syncTasks()).toEqual([]);
  });

  it("既定でないブランチと、ほかのリポジトリの push では足さない", async () => {
    await withDocs(world);
    // 既定でないブランチへの push は設計書の main ではない
    await pushDocs({ ref: "refs/heads/draft", after: "a".repeat(40) });
    // サービスのリポジトリへの push は設計書の push ではない
    await pushDocs({ repo: REPO, after: "b".repeat(40) });
    expect(await syncTasks()).toEqual([]);
  });

  it("消した道と足した道だけの push でも足す", async () => {
    await withDocs(world);
    await pushDocs({ commits: [{ removed: [FEATURE] }] });
    expect(await syncTasks()).toHaveLength(1);
  });

  it("commits が 20 件なら変えた道が分からないので触ったとみなす", async () => {
    await withDocs(world);
    const other = Array.from({ length: 20 }, () => ({ modified: ["README.md"] }));
    await pushDocs({ commits: other.slice(0, 19) });
    expect(await syncTasks()).toEqual([]);
    await pushDocs({ after: MAIN, commits: other });
    expect(await syncTasks()).toHaveLength(1);
  });

  it("検討の段階のサービスには足さない", async () => {
    await withDocs(world);
    await world.d1.DB.prepare("UPDATE services SET stage = 'study'").run();
    await pushDocs();
    expect(await syncTasks()).toEqual([]);
  });

  it("doing 中の push で次のタスクが 1 つ足される", async () => {
    await withDocs(world);
    await pushDocs();
    await world.d1.DB.prepare("UPDATE nodes SET status = 'doing' WHERE source LIKE 'issue-sync:%' AND scope = (SELECT id FROM services WHERE repo = 'example/video-maker')").run();
    await pushDocs({ after: MAIN });
    await pushDocs({ after: "d".repeat(39) + "1" });
    expect((await syncTasks()).map((t) => t["status"])).toEqual(["doing", "todo"]);
  });

  it("本文が変わった要件と消えた要件を一覧に出す", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る"), child("動画を見る")]));
    world.gate.github.contents.set(`${NEXT}:${FEATURE}`, detail({ first: "台本から作る", second: null }));
    world.gate.github.set(`GET /repos/${DOCS}/git/trees/${NEXT}`, { sha: NEXT, tree: [{ path: FEATURE, mode: "100644", type: "blob", sha: "1".repeat(40) }], truncated: false });
    await pushDocs();
    const body = String((await syncTasks())[0]?.["body"]);
    expect(body).toContain("足した要件: なし");
    expect(body).toContain("本文が変わった要件: 1-video 動画を作る");
    expect(body).toContain("消えた要件: 1-video 動画を見る");
  });

  it("機能のファイルが 60 件までは読み、61 件目からは読み切れないと書く", async () => {
    await withDocs(world);
    for (const [n, sha] of [[60, NEXT], [61, MAIN]] as const) {
      world.gate.github.set(`GET /repos/${DOCS}/git/trees/${sha}`, { sha, tree: featureTree(n), truncated: false });
      for (let i = 0; i < n; i += 1) world.gate.github.contents.set(`${sha}:${BASE}/${String(i + 1)}-f.md`, `# 詳細設計 ${String(i + 1)}. f\n\n## 1. 要件\n\n- **要件${String(i)}**: 本文\n`);
    }
    await pushDocs();
    expect(String((await syncTasks())[0]?.["body"])).not.toContain("読み切れない");
    await world.d1.DB.prepare("UPDATE nodes SET status = 'done' WHERE source LIKE 'issue-sync:%' AND scope = (SELECT id FROM services WHERE repo = 'example/video-maker')").run();
    await pushDocs({ after: MAIN });
    const second = await syncTasks();
    expect(String(second[1]?.["body"])).toContain("読み切れない");
    expect(String(second[1]?.["body"])).toContain("消えた要件: 読み切れないので分からない");
  });
});

describe("自分で作った Issue の通知", () => {
  it("ゲートウェイが作った Issue の通知は、分けるタスクにしない", async () => {
    const id = await withDocs(world);
    await plan(world, planOf(id, [child("動画を作る")]));
    const made = issuesOf(world);
    // 本文の印を主に見る。送った者が人でも、印があれば社長の分けるタスクにしない
    await issueEvent({ number: 2, title: "動画を作る", body: made[1]?.body ?? "" });
    // 行を書けなかった (dev_issues に無い番号の) Issue も、印があれば見分ける
    await issueEvent({ number: 55, title: "動画を作る", body: made[1]?.body ?? "" });
    // 本文の印が無くなっても、dev_issues にある番号は補助で見分ける
    await issueEvent({ number: 2, title: "動画を作る", body: "印の無い本文" });
    // コメントの通知は、今の受け口でタスクにならない
    await issueEvent({ number: 2, title: "動画を作る", body: made[1]?.body ?? "" }, "issue_comment");
    expect(await devRows(world)).toHaveLength(2);
    expect(await intakeTasks()).toEqual([]);
  });

  it("ほかの人が開いた Issue は社長の分けるタスクになる", async () => {
    await withDocs(world);
    await issueEvent({ number: 77, title: "人が書いた Issue", body: "本文" });
    expect(await intakeTasks()).toMatchObject([{ title: "人が書いた Issue", issue_number: 77 }]);
  });
});
