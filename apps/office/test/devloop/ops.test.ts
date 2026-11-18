// 見つけて直す仕組みの Issue を、運用の段階のサービスでは運用の親の子にして、設計書の子と同じ形で回す (開発の回し方の 3.7)
import { describe, expect, it } from "vitest";
import { AppError } from "@know-office/core";
import { syncIssues } from "../../src/gate/findings/scan.ts";
import type { DevIssues } from "../../src/gate/devloop/dev-issues.ts";
import { REPO } from "../helpers/docs.ts";
import { issuesOf, pacedForge, withDocs } from "../helpers/issues.ts";
import { clockIn, rows, useWork } from "../helpers/work.ts";
import { fakeTracker } from "../helpers/weekly.ts";

const world = useWork({ github: true });

const NOW = Date.UTC(2026, 0, 10);

/**
 * 運用の段階のサービスを用意する
 * @param stage サービスの段階
 * @returns サービス ID
 */
async function serviceAt(stage = "service"): Promise<string> {
  const id = await withDocs(world);
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await world.d1.DB.prepare("UPDATE services SET stage = ? WHERE id = ?").bind(stage, id).run();
  await clockIn(world, "president", "builder", "reviewer");
  return id;
}

/**
 * 見つけた原因を置く
 * @param fingerprint 指紋
 * @param kind 種類
 * @param repo リポジトリ。大文字小文字は違ってよい
 */
async function finding(fingerprint: string, kind = "error", repo = REPO): Promise<void> {
  await world.d1.DB.prepare("INSERT INTO findings (id, fingerprint, repo, issue_number, kind, count, first_at, last_at, status) VALUES (?, ?, ?, NULL, ?, 5, ?, ?, 'open')").bind(crypto.randomUUID(), fingerprint, repo, kind, NOW - 1000, NOW).run();
}

/**
 * 作れなかった Issue を作る定期ジョブを呼ぶ
 * @param issues GitHub の口
 * @param at 時刻
 */
async function sync(issues: DevIssues = pacedForge(world).issues, at = NOW): Promise<void> {
  await syncIssues(world.gate.env, fakeTracker(), at, issues);
}

/** @returns 運用の行 */
function opsRows() {
  return rows(world.d1.DB, "SELECT kind, number, parent_number, state, issue_kind, paths, heads FROM dev_issues WHERE feature = 'operations' ORDER BY kind DESC, number");
}

describe("運用の Issue", () => {
  it("運用の段階のサービスの原因は、運用の親の子の Issue になり、開発担当のタスクが付く", async () => {
    await serviceAt();
    await finding("a".repeat(64));
    await sync();
    const got = await opsRows();
    expect(got.map((r) => [r["kind"], r["state"], r["issue_kind"]])).toEqual([["parent", "open", null], ["child", "open", "bug"]]);
    expect(got[1]?.["parent_number"]).toBe(got[0]?.["number"]);
    expect(got[1]?.["heads"]).toBe('[""]');
    expect(await rows(world.d1.DB, "SELECT issue_number FROM findings")).toEqual([{ issue_number: got[1]?.["number"] }]);
    const task = await rows(world.d1.DB, "SELECT assignee, task_kind FROM nodes WHERE source = ?", `issue:${String(got[1]?.["number"])}`);
    expect(task).toEqual([{ assignee: "builder", task_kind: "fix" }]);
    expect(issuesOf(world)).toHaveLength(2);
  });

  it("遅い所と無駄な費用は chore の子になる。リポジトリは大文字小文字を問わず探す", async () => {
    await serviceAt("operation");
    await finding("b".repeat(64), "slow", REPO.toUpperCase());
    await sync();
    expect((await opsRows()).map((r) => r["issue_kind"])).toEqual([null, "chore"]);
  });

  it("運用の段階でないサービスの原因は、運用の親を作らず今まで通りの Issue にする", async () => {
    await serviceAt("prototype");
    await finding("a".repeat(64));
    const tracker = fakeTracker();
    await syncIssues(world.gate.env, tracker, NOW, pacedForge(world).issues);
    expect(await opsRows()).toEqual([]);
    expect(tracker.issues).toHaveLength(1);
  });

  it("Issue を作る前に、印を付けた pending の行を置く (社長の取り込みのタスクにしない)", async () => {
    await serviceAt();
    await finding("a".repeat(64));
    const real = pacedForge(world).issues;
    const seen: number[] = [];
    await sync({
      ...real,
      createIssue: async (repo, input) => {
        const [row] = await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM dev_issues WHERE feature = 'operations' AND state = 'pending' AND kind = 'child'");
        seen.push(Number(row?.["n"]));
        return real.createIssue(repo, input);
      },
    });
    // 親を作る時は子の行がまだ無く、子を作る時に子の pending の行がある
    expect(seen).toEqual([0, 1]);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM nodes WHERE assignee = 'president' AND source LIKE 'issue:%'")).toEqual([{ n: 0 }]);
  });

  it("運用の親は 1 つ。同時に 2 つの原因が来ても、親は作り直さず、子を作れなかった方は次の回に作る", async () => {
    await serviceAt();
    await finding("a".repeat(64));
    await finding("b".repeat(64));
    await Promise.all([sync(), sync()]);
    await sync(undefined, NOW + 10 * 60_000);
    const got = await opsRows();
    expect(got.filter((r) => r["kind"] === "parent")).toHaveLength(1);
    expect(got.filter((r) => r["kind"] === "child")).toHaveLength(2);
    expect(issuesOf(world)).toHaveLength(3);
    const found = await rows(world.d1.DB, "SELECT issue_number, claimed_at FROM findings");
    expect(found.map((r) => typeof r["issue_number"])).toEqual(["number", "number"]);
    expect(found.map((r) => r["claimed_at"])).toEqual([null, null]);
  });

  it("子を作った後、つなぐ前に落ちても、次の回に印で見つけ、Issue は 1 件のまま", async () => {
    await serviceAt();
    await finding("a".repeat(64));
    const real = pacedForge(world).issues;
    let calls = 0;
    await sync({
      ...real,
      linkSubIssue: (repo, parent, childId) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new AppError("upstream_failed", "つなげない")) : real.linkSubIssue(repo, parent, childId);
      },
    });
    expect(await rows(world.d1.DB, "SELECT issue_number FROM findings")).toEqual([{ issue_number: null }]);
    expect((await opsRows()).map((r) => r["state"])).toEqual(["open", "pending"]);
    await sync(undefined, NOW + 10 * 60_000);
    expect(issuesOf(world)).toHaveLength(2);
    expect((await opsRows()).map((r) => r["state"])).toEqual(["open", "open"]);
    expect(await rows(world.d1.DB, "SELECT issue_number FROM findings WHERE issue_number IS NULL")).toEqual([]);
  });

  it("閉じた運用の親に新しい原因の子が来たら、親を開き直す", async () => {
    await serviceAt();
    await finding("a".repeat(64));
    await sync();
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = 1, close_reason = 'completed' WHERE feature = 'operations'").run();
    const [parent] = await opsRows();
    await pacedForge(world).issues.close(REPO, Number(parent?.["number"]), "completed");
    await finding("c".repeat(64));
    await sync(undefined, NOW + 10 * 60_000);
    expect((await opsRows())[0]?.["state"]).toBe("open");
    expect(issuesOf(world).find((i) => i.number === parent?.["number"])?.state).toBe("open");
  });
});
