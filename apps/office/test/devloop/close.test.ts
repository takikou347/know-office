// main に入れた子 Issue を、ゲートウェイが閉じる。閉じられなければ 5 分ごとに 12 回まで閉じ直し、諦めたらエラーログに残す (開発の回し方の 3.5)
import { describe, expect, it } from "vitest";
import { child, issuesOf, pacedForge, plan, planOf, withDocs } from "../helpers/issues.ts";
import { advance, clockIn, MINUTE, rows, tool, useWork } from "../helpers/work.ts";
import { retryMirrors } from "../../src/gate/github/mirror.ts";
import type { DevIssues } from "../../src/gate/devloop/dev-issues.ts";

const world = useWork({ github: true });

/**
 * 子 1 件を作り、開発担当が PR を出し、レビュー担当が承認する直前まで進める
 * @param closes 閉じる口を差し替える。無ければ代わりの GitHub に向けた物
 * @returns Issue の番号
 */
async function reviewed(closes?: (real: DevIssues) => DevIssues): Promise<number> {
  const id = await withDocs(world);
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await clockIn(world, "president", "builder", "reviewer");
  const made = await plan(world, planOf(id, [child("動画を作る", { kind: "feature" })]));
  world.forge.compare = () => Promise.resolve({ files: [{ path: "src/a.test.ts", status: "added", patch: null }], truncated: false });
  const real = pacedForge(world).issues;
  world.forge.issues = closes === undefined ? real : closes(real);
  expect(await tool(world, "builder", "pr_open", { name: "make", title: "動画を作る", body: "" })).toMatchObject({ isError: false });
  return made.children[0]?.number ?? 0;
}

/**
 * レビュー担当が承認して、main に入れる
 * @returns main に入れたか
 */
async function approve(): Promise<unknown> {
  await advance(world, world.clock.now());
  const answer = await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "確かめた", headSha: "b".repeat(40) });
  return JSON.parse(answer.content);
}

/** @returns dev_issues の子の状態 */
async function childState(): Promise<unknown> {
  return (await rows(world.d1.DB, "SELECT state FROM dev_issues WHERE kind = 'child'"))[0]?.["state"];
}

describe("1 Issue を 1 回の作業で入れる", () => {
  it("入れたら閉じる", async () => {
    const number = await reviewed();
    expect(await approve()).toEqual({ merged: true });
    expect(issuesOf(world).find((i) => i.number === number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(await childState()).toBe("closed");
    expect(await rows(world.d1.DB, "SELECT kind, sent_at IS NOT NULL AS sent FROM github_mirrors WHERE kind = 'issue_close'")).toEqual([{ kind: "issue_close", sent: 1 }]);
  });

  it("閉じられない Issue", async () => {
    let calls = 0;
    await reviewed((real) => ({
      ...real,
      close: () => {
        calls += 1;
        return Promise.reject(new Error("GitHub が閉じられない"));
      },
    }));
    expect(await approve()).toEqual({ merged: true });
    // 入れた時の 1 回の後、5 分ごとに送り直し、合わせて 12 回で諦める
    for (let i = 0; i < 14; i += 1) {
      world.clock.advance(5 * MINUTE);
      await retryMirrors(world.gate.env, world.forge, world.clock);
    }
    expect(calls).toBe(12);
    expect(await childState()).toBe("open");
    expect((await rows(world.d1.REC_2026, "SELECT code FROM error_events")).map((r) => r["code"])).toContain("github_mirror_gave_up");
  });
});

describe("子 Issue を閉じる確かめ", () => {
  it("閉じる前に落ちても、5 分ごとの送り直しが閉じる", async () => {
    let failing = true;
    const number = await reviewed((real) => ({
      ...real,
      close: (repo, n, reason) => (failing ? Promise.reject(new Error("落ちた")) : real.close(repo, n, reason)),
    }));
    expect(await approve()).toEqual({ merged: true });
    expect(await childState()).toBe("open");
    failing = false;
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, world.forge, world.clock)).toEqual({ sent: 1, failed: 0 });
    expect(issuesOf(world).find((i) => i.number === number)).toMatchObject({ state: "closed", stateReason: "completed" });
    expect(await childState()).toBe("closed");
  });

  it("main に入っていない物は閉じない", async () => {
    const number = await reviewed();
    // main が先に進んでいて入らなかった。積んだ閉じの行は消える
    world.forge.main = "z".repeat(40);
    expect(await approve()).toEqual({ merged: false });
    expect(await rows(world.d1.DB, "SELECT 1 FROM github_mirrors WHERE kind = 'issue_close'")).toEqual([]);
    expect(issuesOf(world).find((i) => i.number === number)?.state).toBe("open");
    // 積んだ後に落ちて残った行は、main が含むと確かめられるまで閉じない
    const [review] = await rows(world.d1.DB, "SELECT id FROM reviews");
    await world.d1.DB.prepare("INSERT INTO github_mirrors (id, review_id, kind, payload, created_at, attempts) VALUES ('m1', ?, 'issue_close', ?, 0, 0)")
      .bind(review?.["id"], JSON.stringify({ issueNumber: number, sha: "b".repeat(40) }))
      .run();
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, world.forge, world.clock)).toEqual({ sent: 0, failed: 1 });
    expect(issuesOf(world).find((i) => i.number === number)?.state).toBe("open");
    expect(await childState()).toBe("open");
  });

  it("設計書の変更で外れて閉じた Issue を、入れた後に上書きしない", async () => {
    const number = await reviewed();
    const issue = issuesOf(world).find((i) => i.number === number);
    if (issue === undefined) throw new Error("Issue が無い");
    // 要件が外れて not_planned で閉じた後に、取っていた作業が入る
    issue.state = "closed";
    issue.stateReason = "not_planned";
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = 1 WHERE number = ?").bind(number).run();
    expect(await approve()).toEqual({ merged: true });
    expect(issue).toMatchObject({ state: "closed", stateReason: "not_planned" });
  });

  it("GitHub の Closes で先に閉じられていても、行を直す", async () => {
    const number = await reviewed();
    const issue = issuesOf(world).find((i) => i.number === number);
    if (issue === undefined) throw new Error("Issue が無い");
    issue.state = "closed";
    issue.stateReason = "completed";
    expect(await approve()).toEqual({ merged: true });
    expect(await childState()).toBe("closed");
  });
});
