// 週に 1 度、記録のエラーを原因の指紋ごとにまとめ、1 つの原因を 1 件の Issue にする事。直しに費用か外との連携が要る時はオーナーに上げる (サービスと拡張の 3.7)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { syncIssues } from "../../src/gate/findings/scan.ts";
import { fingerprintMark } from "../../src/gate/findings/tracker.ts";
import { pollBatches, startBatch } from "../../src/gate/jobs/weekly.ts";
import { advance, api, REPO, rows, type WorkWorld } from "../helpers/work.ts";
import { addErrors, answerJson, dec, fakeTracker, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const SAME = "a".repeat(64);
const OTHER = "b".repeat(64);

const ANSWER = answerJson({ title: "ノードの一覧で undefined を読む", steps: ["GET /api/v1/nodes を親の無いノードで呼ぶ", "500 が返る"], needs: null, reason: "親を確かめていない" });

/**
 * 直しに費用か外との連携が要ると答える。f0 は費用、ほかは外との連携
 * @param id custom_id
 * @returns 積む答え
 */
function needs(id: string) {
  return answerJson({ title: "Claude の上限", steps: ["社員を 3 人で動かす"], needs: id === "f0" ? "cost_increase" : "external_integration", reason: "上位のプランが要る" });
}

/**
 * 調べる先のリポジトリを決める
 * @param w テストの物
 */
function useRepo(w: WorkWorld): void {
  Object.assign(w.gate.env, { OFFICE_REPO: REPO });
}

describe("見つけて直す", () => {
  it("同じ原因をまとめる", async () => {
    useRepo(world);
    // 同じ原因の失敗が 1 週間に 12 回。ほかの原因が 2 回
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 5 });
    await addErrors(world, { at: dec(4, 15), fingerprint: SAME, count: 7 });
    await addErrors(world, { at: dec(2, 9), fingerprint: OTHER, count: 2, route: "/api/v1/services" });
    const tracker = fakeTracker();
    await runBatch(world, "findings", (id) => (id === "f0" ? ANSWER : answerJson({ title: "サービスの一覧", steps: ["一覧を開く"], needs: null, reason: "x" })), tracker, dec(7, 4));

    const same = tracker.issues.filter((i) => i.body.includes(fingerprintMark(SAME)));
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ repo: REPO, title: "ノードの一覧で undefined を読む" });
    expect(same[0]?.body).toContain("起きた回数: 12");
    expect(same[0]?.body).toContain("1. GET /api/v1/nodes を親の無いノードで呼ぶ\n2. 500 が返る");
    expect(tracker.issues).toHaveLength(2);
    expect(await rows(world.d1.DB, "SELECT fingerprint, repo, issue_number, kind, count, first_at, last_at, status FROM findings ORDER BY fingerprint")).toEqual([
      { fingerprint: SAME, repo: REPO, issue_number: same[0]?.number, kind: "error", count: 12, first_at: dec(1, 10), last_at: dec(4, 15, 6), status: "open" },
      { fingerprint: OTHER, repo: REPO, issue_number: expect.any(Number) as unknown, kind: "error", count: 2, first_at: dec(2, 9), last_at: dec(2, 9, 1), status: "open" },
    ]);

    // 次の週も同じ原因なら、新しい Issue を作らず、同じ Issue に回数と再現の手順を足す
    await addErrors(world, { at: dec(8, 10), fingerprint: SAME, count: 3 });
    await runBatch(world, "findings", () => ANSWER, tracker, dec(14, 4));
    expect(tracker.issues).toHaveLength(2);
    expect(same[0]?.comments).toHaveLength(1);
    expect(same[0]?.comments[0]).toContain("この週に 3 回、合わせて 15 回");
    expect(same[0]?.comments[0]).toContain("1. GET /api/v1/nodes を親の無いノードで呼ぶ");
    expect(await rows(world.d1.DB, "SELECT count FROM findings WHERE fingerprint = ?", SAME)).toEqual([{ count: 15 }]);

    // オーナーは記録の画面で Issue の一覧を読める
    await advance(world, dec(14, 9));
    const listed = z.array(z.object({ issueNumber: z.number().nullable(), count: z.number(), kind: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/findings?status=open"));
    expect(listed.map((f) => f.count).toSorted((a, b) => a - b)).toEqual([2, 15]);
  });

  it("費用が増える直し", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 4 });
    await addErrors(world, { at: dec(1, 11), fingerprint: OTHER, count: 4 });
    const tracker = fakeTracker();
    await runBatch(world, "findings", needs, tracker, dec(7, 4));
    const findings = await rows(world.d1.DB, "SELECT id, fingerprint FROM findings ORDER BY fingerprint");
    expect(await rows(world.d1.DB, "SELECT kind, target, status, requested_by FROM approvals ORDER BY kind")).toEqual([
      { kind: "cost_increase", target: findings[0]?.["id"], status: "pending", requested_by: "reviewer" },
      { kind: "external_integration", target: findings[1]?.["id"], status: "pending", requested_by: "reviewer" },
    ]);
    // 次の週に同じ答えが来ても、決まるまで重ねて上げない
    await addErrors(world, { at: dec(8, 10), fingerprint: SAME, count: 1 });
    await runBatch(world, "findings", () => needs("f0"), tracker, dec(14, 4));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM approvals")).toEqual([{ n: 2 }]);
  });
});

describe("同じ原因の Issue", () => {
  it("Issue を作れなかった時は次に作り、前に作った Issue が本文の指紋で見つかれば作り直さない", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 12 });
    await addErrors(world, { at: dec(1, 11), fingerprint: OTHER, count: 1 });
    const tracker = fakeTracker();
    // OTHER の Issue は前の回に作ったが、番号を書く前に落ちた事にする
    tracker.issues.push({ repo: REPO, number: 1, title: "前の回", body: `x\n${fingerprintMark(OTHER)}`, comments: [], closed: false });
    tracker.down = true;
    await runBatch(world, "findings", () => ANSWER, tracker, dec(7, 4));
    expect(await rows(world.d1.DB, "SELECT count, issue_number FROM findings ORDER BY fingerprint")).toEqual([
      { count: 12, issue_number: null },
      { count: 1, issue_number: 1 },
    ]);
    tracker.down = false;
    await pollBatches(world.gate.env, { fetch: world.gate.fetch, tracker }, dec(7, 4, 10));
    expect(tracker.issues).toHaveLength(2);
    expect(await rows(world.d1.DB, "SELECT issue_number FROM findings ORDER BY fingerprint")).toEqual([{ issue_number: 2 }, { issue_number: 1 }]);
    expect(tracker.issues[1]?.body).toContain("起きた回数: 12");
  });

  it("同時に結果を読んでも、1 つの原因に Issue は 1 件", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 12 });
    const tracker = fakeTracker();
    const deps = { fetch: world.gate.fetch, tracker };
    await startBatch(world.gate.env, "findings", deps, dec(7, 4));
    world.gate.claude.endBatch(world.gate.claude.batches[0]?.id ?? "", () => ANSWER);
    // Issue を作っている間に、別の定期ジョブが作れていない Issue を作り直しに来る
    tracker.beforeCreate = async () => {
      tracker.beforeCreate = null;
      await syncIssues(world.gate.env, tracker, dec(7, 4, 6));
    };
    await Promise.all([pollBatches(world.gate.env, deps, dec(7, 4, 5)), pollBatches(world.gate.env, deps, dec(7, 4, 5))]);
    expect(tracker.issues).toHaveLength(1);
    // 手順は先に作り始めた方の答えから入る
    expect(tracker.issues[0]?.body).toContain("1. GET /api/v1/nodes を親の無いノードで呼ぶ");
    expect(await rows(world.d1.DB, "SELECT count, issue_number, claimed_at FROM findings")).toEqual([{ count: 12, issue_number: 1, claimed_at: null }]);
  });

  it("作り直しの定期ジョブが印を持っている間に次の週の結果が入っても、1 つの原因に Issue は 1 件", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 12 });
    const tracker = fakeTracker();
    tracker.down = true;
    await runBatch(world, "findings", () => ANSWER, tracker, dec(7, 4));
    expect(await rows(world.d1.DB, "SELECT issue_number FROM findings")).toEqual([{ issue_number: null }]);
    tracker.down = false;
    await addErrors(world, { at: dec(8, 10), fingerprint: SAME, count: 3 });
    const deps = { fetch: world.gate.fetch, tracker };
    await startBatch(world.gate.env, "findings", deps, dec(14, 4));
    world.gate.claude.endBatch(world.gate.claude.batches.at(-1)?.id ?? "", () => ANSWER);
    // 定期ジョブが印を付けて Issue を作っている間に、次の週の結果が入る
    tracker.beforeCreate = async () => {
      tracker.beforeCreate = null;
      await pollBatches(world.gate.env, deps, dec(14, 4, 5));
    };
    await syncIssues(world.gate.env, tracker, dec(14, 4, 1));
    // 前の週に作れなかった失敗も記録のエラーとして数えるので、SAME の分だけを見る
    expect(tracker.issues.filter((i) => i.body.includes(fingerprintMark(SAME)))).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT count, claimed_at FROM findings WHERE fingerprint = ? AND issue_number IS NOT NULL", SAME)).toEqual([{ count: 15, claimed_at: null }]);
  });

  it("Claude が答えなかった原因も回数を数え、手順の無い Issue にする", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 3 });
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => "errored", tracker, dec(7, 4));
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]?.body).toContain("起きた回数: 3");
    expect(tracker.issues[0]?.body).toContain("再現の手順は次の調べで足す");
  });

  it("調べる先のリポジトリが決まっていない時は、数えるだけで Issue を作らない", async () => {
    await addErrors(world, { at: dec(1, 10), fingerprint: SAME, count: 3 });
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => ANSWER, tracker, dec(7, 4));
    expect(tracker.issues).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT repo, count, issue_number FROM findings")).toEqual([{ repo: null, count: 3, issue_number: null }]);
  });
});
