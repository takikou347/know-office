// 親 Issue を閉じ、試作のサービスの機能の親がすべて閉じたらサービスに進められると知らせる。閉じ残しは 5 分ごとの見直しが拾う (開発の回し方の 3.7)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@know-office/core";
import { REPO } from "../helpers/docs.ts";
import { child, issuesOf, pacedForge, plan, planOf, withDocs } from "../helpers/issues.ts";
import { advance, clockIn, rows, tool, useWork } from "../helpers/work.ts";
import { runScheduled } from "../../src/gate/jobs/health.ts";
import { isReady, settleParent } from "../../src/gate/devloop/release.ts";
import type { DevIssues } from "../../src/gate/devloop/dev-issues.ts";

const world = useWork({ github: true });

/**
 * 親 1 件と子 2 件を作る。子の要件は設計書の 1 章の 2 つ
 * @param kids 作る子の要件の名前
 * @returns サービス ID、親の番号、子の番号
 */
async function planned(kids = ["動画を作る"]) {
  const service = await withDocs(world);
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await clockIn(world, "president", "builder", "reviewer");
  const made = await plan(world, planOf(service, kids.map((k) => child(k, { kind: "feature" }))));
  return { service, parent: made.parents[0]?.number ?? 0, kids: made.children.map((c) => c.number) };
}

/**
 * 子を閉じた事にする (入れて閉じた)
 * @param numbers 子の番号
 * @param reason 閉じた理由
 */
async function closeKids(numbers: number[], reason = "completed"): Promise<void> {
  for (const n of numbers) await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = 1, close_reason = ? WHERE kind = 'child' AND number = ?").bind(reason, n).run();
}

/** @returns サービスの通知 service_ready の数 */
async function readyNotices(): Promise<number> {
  return z.number().parse((await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM notices WHERE kind = 'service_ready'"))[0]?.["n"]);
}

/**
 * 親 Issue の今を読む
 * @param parent 親の番号
 * @returns 代わりの GitHub の状態と理由、行の状態と理由
 */
async function parentNow(parent: number) {
  const [row] = await rows(world.d1.DB, "SELECT state, close_reason FROM dev_issues WHERE kind = 'parent' AND number = ?", parent);
  const issue = issuesOf(world).find((i) => i.number === parent);
  return { github: [issue?.state, issue?.stateReason], row: [row?.["state"], row?.["close_reason"]] };
}

/**
 * 子の閉じの後始末を呼ぶ
 * @param number 閉じた子の番号
 * @param issues GitHub の口。無ければ代わりの GitHub に向けた物
 */
async function settle(number: number, issues: DevIssues = pacedForge(world).issues): Promise<void> {
  await settleParent(world.gate.env, issues, REPO, number, world.clock.now());
}

describe("リリースと運用につなぐ", () => {
  it("親が閉じる", async () => {
    const { parent, kids } = await planned();
    await closeKids(kids);
    await settle(kids[0] ?? 0);
    expect(await parentNow(parent)).toEqual({ github: ["closed", "completed"], row: ["closed", "completed"] });
  });

  it("子が残っていれば親を閉じない", async () => {
    const { parent, kids } = await planned(["動画を作る", "動画を見る"]);
    await closeKids(kids.slice(0, 1));
    await settle(kids[0] ?? 0);
    expect((await parentNow(parent)).row).toEqual(["open", null]);
    // 作っている途中 (pending) の子がいる間も閉じない
    await closeKids(kids);
    await world.d1.DB.prepare("INSERT INTO dev_issues (id, service_id, repo, number, parent_number, kind, feature, requirement, req_hash, issue_kind, paths, mark_key, state, created_at) SELECT ?, service_id, repo, NULL, ?, 'child', feature, '作りかけ', 'x', 'feature', '[]', ?, 'pending', 0 FROM dev_issues WHERE kind = 'parent'")
      .bind(crypto.randomUUID(), parent, "a".repeat(64))
      .run();
    await settle(kids[0] ?? 0);
    expect((await parentNow(parent)).row).toEqual(["open", null]);
    expect(await readyNotices()).toBe(0);
  });

  it("全部が設計書から消えて閉じた子の親は、not_planned で閉じる", async () => {
    const { parent, kids } = await planned(["動画を作る", "動画を見る"]);
    await closeKids(kids, "not_planned");
    await settle(kids[0] ?? 0);
    expect(await parentNow(parent)).toEqual({ github: ["closed", "not_planned"], row: ["closed", "not_planned"] });
    // 入れて閉じた子が 1 つも無い親だけが閉じても、サービスに進められるとは知らせない
    expect(await readyNotices()).toBe(0);
  });

  it("サービスに進められると知らせる", async () => {
    const { service, kids } = await planned();
    expect(await isReady(world.d1.DB, service)).toBe(false);
    await closeKids(kids);
    await settle(kids[0] ?? 0);
    expect(await isReady(world.d1.DB, service)).toBe(true);
    const found = await rows(world.d1.DB, "SELECT id, level, scope, title FROM notices WHERE kind = 'service_ready'");
    expect(found).toMatchObject([{ level: "info", scope: service }]);
    expect(world.gate.live.published).toContainEqual({ type: "notice", notice: { id: found[0]?.["id"] } });
  });

  it("知らせは重ねない", async () => {
    const { parent, kids } = await planned();
    await closeKids(kids);
    // 1 つ目の呼びが GitHub の親を閉じる所で待つ間に、2 つ目の呼びが閉じて通知を足し、オーナーが読む。1 つ目の閉じる文は取れず、通知を足さない
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const real = pacedForge(world).issues;
    const first = settle(kids[0] ?? 0, {
      ...real,
      close: async (repo, number, reason) => {
        await gate;
        await real.close(repo, number, reason);
      },
    });
    await settle(kids[0] ?? 0);
    await world.d1.DB.prepare("UPDATE notices SET read_at = 1 WHERE kind = 'service_ready'").run();
    release();
    await first;
    expect(await readyNotices()).toBe(1);
    expect((await parentNow(parent)).row).toEqual(["closed", "completed"]);
    // 送り直しの 3 度目も重ねない
    await settle(kids[0] ?? 0);
    expect(await readyNotices()).toBe(1);
  });

  it("試作でないサービスは知らせない", async () => {
    const { service, parent, kids } = await planned();
    await world.d1.DB.prepare("UPDATE services SET stage = 'service' WHERE id = ?").bind(service).run();
    await closeKids(kids);
    await settle(kids[0] ?? 0);
    expect((await parentNow(parent)).row).toEqual(["closed", "completed"]);
    expect(await readyNotices()).toBe(0);
  });

  it("閉じ残しは見直しで閉じる", async () => {
    const { parent, kids } = await planned();
    // 子を閉じた後、親を閉じる前に落ちた
    await closeKids(kids);
    expect((await parentNow(parent)).row).toEqual(["open", null]);
    // 5 分ごとの定期ジョブの入り口から通す
    const pending: Promise<unknown>[] = [];
    await advance(world, world.clock.now() + 5 * 60_000);
    runScheduled(world.gate.env, { waitUntil: (p) => void pending.push(p) }, world.clock, { fetch: world.gate.fetch, tracker: world.gate.tracker });
    await Promise.allSettled(pending);
    expect(await parentNow(parent)).toEqual({ github: ["closed", "completed"], row: ["closed", "completed"] });
    expect(await readyNotices()).toBe(1);
  });

  it("親の閉じに GitHub が失敗しても行は open のまま", async () => {
    const { parent, kids } = await planned();
    await closeKids(kids);
    const real = pacedForge(world).issues;
    await expect(settle(kids[0] ?? 0, { ...real, close: () => Promise.reject(new AppError("upstream_failed", "GitHub が閉じられない")) })).rejects.toMatchObject({ code: "upstream_failed" });
    expect((await parentNow(parent)).row).toEqual(["open", null]);
    expect(await readyNotices()).toBe(0);
    await settle(kids[0] ?? 0);
    expect((await parentNow(parent)).row).toEqual(["closed", "completed"]);
  });

  it("閉じる間に子が足されたら、閉じた親を GitHub で開き直す", async () => {
    const { parent, kids } = await planned();
    await closeKids(kids);
    const real = pacedForge(world).issues;
    // GitHub の親を閉じた後、行を閉じる前に、別の呼びが新しい子の行を取った
    await settle(kids[0] ?? 0, {
      ...real,
      close: async (repo, number, reason) => {
        await real.close(repo, number, reason);
        await world.d1.DB.prepare("INSERT INTO dev_issues (id, service_id, repo, number, parent_number, kind, feature, requirement, req_hash, issue_kind, paths, mark_key, state, created_at) SELECT ?, service_id, repo, NULL, ?, 'child', feature, '新しい', 'y', 'feature', '[]', ?, 'pending', 0 FROM dev_issues WHERE kind = 'parent'")
          .bind(crypto.randomUUID(), parent, "b".repeat(64))
          .run();
      },
    });
    expect(await parentNow(parent)).toEqual({ github: ["open", "reopened"], row: ["open", null] });
    expect(await readyNotices()).toBe(0);
  });

  it("閉じた親に子が増えたら開き直し、また全部閉じたら知らせ直す", async () => {
    const { service, parent, kids } = await planned();
    await closeKids(kids);
    await settle(kids[0] ?? 0);
    expect(await readyNotices()).toBe(1);
    await world.d1.DB.prepare("UPDATE notices SET read_at = 1 WHERE kind = 'service_ready'").run();
    // 設計書の別の要件の子が足される
    const added = await plan(world, planOf(service, [child("動画を作る", { kind: "feature" }), child("動画を見る", { kind: "feature" })]));
    expect(await parentNow(parent)).toEqual({ github: ["open", "reopened"], row: ["open", null] });
    const more = added.children.filter((c) => c.created).map((c) => c.number);
    await closeKids(more);
    await settle(more[0] ?? 0);
    expect(await readyNotices()).toBe(2);
  });

  it("同時に子を足しても、閉じた親を開き直すのは 1 つだけ", async () => {
    const { service, parent, kids } = await planned();
    await closeKids(kids);
    await settle(kids[0] ?? 0);
    let reopened = 0;
    const real = pacedForge(world).issues;
    const counting = pacedForge(world);
    counting.issues = {
      ...real,
      reopen: async (repo, number) => {
        reopened += 1;
        await real.reopen(repo, number);
      },
    };
    const both = await Promise.allSettled([
      plan(world, planOf(service, [child("動画を作る", { kind: "feature" }), child("動画を見る", { kind: "feature" })]), counting),
      plan(world, planOf(service, [child("動画を作る", { kind: "feature" }), child("動画を見る", { kind: "feature" })]), counting),
    ]);
    expect(reopened).toBe(1);
    expect((await parentNow(parent)).row).toEqual(["open", null]);
    expect(both.some((r) => r.status === "fulfilled")).toBe(true);
    void tool;
  });
});
