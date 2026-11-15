// 直した Issue の効き目を、直した後の 7 日と前の 7 日のエラーの回数で比べ、Issue に書く事。効かなければ戻すタスクを足す (サービスと拡張の 3.7)
import { describe, expect, it } from "vitest";
import { checkEffects, markFixed } from "../../src/gate/findings/effect.ts";
import { runDaily } from "../../src/gate/jobs/daily.ts";
import { REPO, rows, type WorkWorld } from "../helpers/work.ts";
import { addErrors, answerJson, DAY, dec, fakeTracker, type FakeTracker, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const SAME = "c".repeat(64);
const ANSWER = answerJson({ title: "保存で落ちる", steps: ["保存する"], needs: null, reason: "x" });

/**
 * 12 回のエラーから Issue を作る
 * @param w テストの物
 * @returns GitHub の Issue の代わり
 */
async function openIssue(w: WorkWorld): Promise<FakeTracker> {
  Object.assign(w.gate.env, { OFFICE_REPO: REPO });
  await addErrors(w, { at: dec(3, 10), fingerprint: SAME, count: 12 });
  const tracker = fakeTracker();
  await runBatch(w, "findings", () => ANSWER, tracker, dec(7, 4));
  return tracker;
}

describe("見つけて直す", () => {
  it("効き目を確かめる", async () => {
    const tracker = await openIssue(world);
    const fixed = dec(8, 12);
    // 開発担当が直した PR が入り、Issue が閉じた
    expect(await markFixed(world.gate.env, REPO, 1, fixed)).toBe(true);
    await addErrors(world, { at: fixed + DAY, fingerprint: SAME, count: 1 });
    // 7 日たつまでは比べない
    await checkEffects(world.gate.env, tracker, fixed + 7 * DAY - 1);
    expect(tracker.issues[0]?.comments).toEqual([]);
    await checkEffects(world.gate.env, tracker, fixed + 7 * DAY);
    // 前の 7 日は 12 回、後の 7 日は 1 回
    expect(await rows(world.d1.DB, "SELECT status, fixed_at, effect FROM findings")).toEqual([{ status: "verified", fixed_at: fixed, effect: JSON.stringify({ before: 12, after: 1 }) }]);
    expect(tracker.issues[0]?.comments.at(-1)).toContain("直す前の 7 日は 12 回、直した後の 7 日は 1 回");
    expect(tracker.issues[0]?.closed).toBe(true);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM nodes WHERE kind = 'task'")).toEqual([{ n: 0 }]);
    // 2 度目は何もしない
    await checkEffects(world.gate.env, tracker, fixed + 8 * DAY);
    expect(tracker.issues[0]?.comments).toHaveLength(1);
  });

  it("効かなければ戻すタスクを足す", async () => {
    const tracker = await openIssue(world);
    const fixed = dec(8, 12);
    await markFixed(world.gate.env, REPO, 1, fixed);
    await addErrors(world, { at: fixed + DAY, fingerprint: SAME, count: 12 });
    await checkEffects(world.gate.env, tracker, fixed + 7 * DAY);
    expect(await rows(world.d1.DB, "SELECT status, effect FROM findings")).toEqual([{ status: "reverted", effect: JSON.stringify({ before: 12, after: 12 }) }]);
    expect(await rows(world.d1.DB, "SELECT task_kind, assignee, status, repo, issue_number FROM nodes WHERE kind = 'task'")).toEqual([
      { task_kind: "fix", assignee: "builder", status: "todo", repo: REPO, issue_number: 1 },
    ]);
    expect(tracker.issues[0]?.comments.at(-1)).toContain("効かなかったので、直しを戻すタスクを足した");
  });
});

describe("効き目の確かめ方", () => {
  it("毎日 0 時 5 分の定期ジョブが、7 日たった物を確かめる", async () => {
    const tracker = await openIssue(world);
    const fixed = dec(8, 12);
    await markFixed(world.gate.env, REPO, 1, fixed);
    const waits: Promise<unknown>[] = [];
    runDaily(world.gate.env, { waitUntil: (p) => void waits.push(p) }, { now: () => dec(16, 0, 5) }, { fetch: world.gate.fetch, tracker });
    await Promise.all(waits);
    expect(await rows(world.d1.DB, "SELECT status FROM findings")).toEqual([{ status: "verified" }]);
  });

  it("同時に確かめても、書くのと戻すタスクを足すのは 1 度だけ", async () => {
    const tracker = await openIssue(world);
    const fixed = dec(8, 12);
    await markFixed(world.gate.env, REPO, 1, fixed);
    await addErrors(world, { at: fixed + DAY, fingerprint: SAME, count: 13 });
    await Promise.all([checkEffects(world.gate.env, tracker, fixed + 7 * DAY), checkEffects(world.gate.env, tracker, fixed + 7 * DAY)]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM nodes WHERE kind = 'task'")).toEqual([{ n: 1 }]);
    expect(tracker.issues[0]?.comments).toHaveLength(1);
  });

  it("開いていない Issue と知らない Issue は直した事にしない", async () => {
    await openIssue(world);
    expect(await markFixed(world.gate.env, REPO, 99, dec(8))).toBe(false);
    expect(await markFixed(world.gate.env, "example/other", 1, dec(8))).toBe(false);
    expect(await markFixed(world.gate.env, REPO, 1, dec(8))).toBe(true);
    expect(await markFixed(world.gate.env, REPO, 1, dec(9))).toBe(false);
    expect(await rows(world.d1.DB, "SELECT fixed_at FROM findings")).toEqual([{ fixed_at: dec(8) }]);
  });

  it("年をまたぐ 7 日も、両方の年の記録から数える", async () => {
    Object.assign(world.gate.env, { OFFICE_REPO: REPO });
    const tracker = fakeTracker();
    await addErrors(world, { at: dec(28, 10), fingerprint: SAME, count: 4 });
    // 2027 年 1 月 4 日の月曜に、前の週 (12 月 28 日から) を調べる
    await runBatch(world, "findings", () => ANSWER, tracker, Date.UTC(2027, 0, 4, 4 - 9));
    const fixed = Date.UTC(2026, 11, 31, 20 - 9);
    await markFixed(world.gate.env, REPO, 1, fixed);
    // 直した後の 7 日は 2027 年に入る
    await addErrors(world, { at: Date.UTC(2027, 0, 2, 10 - 9), fingerprint: SAME, count: 5 });
    await checkEffects(world.gate.env, tracker, fixed + 7 * DAY);
    expect(await rows(world.d1.DB, "SELECT status, effect FROM findings")).toEqual([{ status: "reverted", effect: JSON.stringify({ before: 4, after: 5 }) }]);
  });
});
