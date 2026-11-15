// 週に 1 度、記録から遅い所と無駄な費用を調べ、目安を超えた物を 1 つずつ Issue にする事と、直した後の効き目の比べ方 (サービスと拡張の 3.7)
import { describe, expect, it } from "vitest";
import { checkEffects, markFixed } from "../../src/gate/findings/effect.ts";
import { costFingerprint, slowFingerprint } from "../../src/gate/findings/slow-cost.ts";
import { fingerprintMark } from "../../src/gate/findings/tracker.ts";
import { REPO, rows, type WorkWorld } from "../helpers/work.ts";
import { addToolCalls, addUsage, answerJson, DAY, dec, fakeTracker, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const SLOW = answerJson({ title: "pnpm verify が遅い", steps: ["e2e を分けて並べて流す"], needs: null, reason: "直列に流している" });
const COST = answerJson({ title: "作る役の読み直しの割引が当たらない", steps: ["説明文の頭に毎回変わる時刻を置かない"], needs: null, reason: "先頭が毎回変わる" });

/**
 * 調べる先のリポジトリを決める
 * @param w テストの物
 */
function useRepo(w: WorkWorld): void {
  Object.assign(w.gate.env, { OFFICE_REPO: REPO });
}

describe("遅い所と無駄な費用", () => {
  it("目安の 60 秒を超えた呼び出しが週に 3 回以上あるツールを、遅い順に並べた Issue にする", async () => {
    useRepo(world);
    await addToolCalls(world, { at: dec(1, 10), tool: "Bash", ms: [61_000, 90_000, 5_000, 120_000, 75_000, 5_000] });
    // 目安を超えたのが 2 回のツールと、目安ちょうどのツールは Issue にしない
    await addToolCalls(world, { at: dec(2, 10), tool: "WebFetch", ms: [70_000, 80_000, 1_000] });
    await addToolCalls(world, { at: dec(2, 11), tool: "Read", ms: [60_000, 60_000, 60_000] });
    // 前の週の外の呼び出しは数えない
    await addToolCalls(world, { at: dec(7, 1), tool: "Bash", ms: [200_000] });
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => SLOW, tracker, dec(7, 4));

    const prompts = (world.gate.claude.batches[0]?.requests ?? []).map((r) => JSON.stringify(r.params.messages));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("種類: 遅い所");
    expect(tracker.issues).toHaveLength(1);
    const issue = tracker.issues[0];
    expect(issue?.title).toBe("pnpm verify が遅い");
    expect(issue?.body).toContain(fingerprintMark(await slowFingerprint("Bash")));
    expect(issue?.body).toContain("目安の 60 秒を超えた回数: 4");
    // 遅い順に並べる
    expect(issue?.body).toContain("1. Bash 120 秒: pnpm test 3\n2. Bash 90 秒: pnpm test 1\n3. Bash 75 秒: pnpm test 4\n4. Bash 61 秒: pnpm test 0");
    expect(issue?.body).toContain("## 直す手順\n\n1. e2e を分けて並べて流す");
    expect(await rows(world.d1.DB, "SELECT kind, count, first_at, last_at FROM findings")).toEqual([{ kind: "slow", count: 4, first_at: dec(1, 10), last_at: dec(1, 10, 4) }]);
  });

  it("読み直しの割引が当たらなかった呼び出しの費用が週に 1 ドル以上の社員を、設定や指示の文の直しの案の Issue にする", async () => {
    useRepo(world);
    // 作る役: 割引の当たらない呼び出し 10 件で 2 ドル。見る役: 割引が当たっている。社長: 当たらないが 0.5 ドル
    await addUsage(world, { at: dec(1, 10), staffId: "builder", count: 10, input: 10_000, cacheRead: 1_000, costMicroUsd: 200_000 });
    await addUsage(world, { at: dec(2, 10), staffId: "reviewer", count: 10, input: 10_000, cacheRead: 90_000, costMicroUsd: 300_000 });
    await addUsage(world, { at: dec(3, 10), staffId: "president", count: 5, input: 10_000, cacheRead: 0, costMicroUsd: 100_000 });
    // 割引の要らない短い呼び出しは数えない
    await addUsage(world, { at: dec(3, 11), staffId: "builder", count: 3, input: 500, cacheRead: 0, costMicroUsd: 400_000 });
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => COST, tracker, dec(7, 4));

    const prompts = (world.gate.claude.batches[0]?.requests ?? []).map((r) => JSON.stringify(r.params.messages));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("種類: 無駄な費用");
    expect(tracker.issues).toHaveLength(1);
    const body = tracker.issues[0]?.body ?? "";
    expect(body).toContain(fingerprintMark(await costFingerprint("builder")));
    expect(body).toContain("社員: builder");
    expect(body).toContain("読み直しの割引が当たらなかった呼び出し: 10 回、2.00 ドル");
    expect(body).toContain("## 直しの案\n\n1. 説明文の頭に毎回変わる時刻を置かない");
    expect(await rows(world.d1.DB, "SELECT kind, count FROM findings")).toEqual([{ kind: "cost", count: 10 }]);
  });

  it("エラー、遅い所、無駄な費用を 1 つのバッチで送り、どれも無い週は送らない", async () => {
    useRepo(world);
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => SLOW, tracker, dec(7, 4));
    expect(world.gate.claude.batches).toEqual([]);
    await addToolCalls(world, { at: dec(8, 10), tool: "Bash", ms: [61_000, 61_000, 61_000] });
    await addUsage(world, { at: dec(9, 10), staffId: "builder", count: 10, input: 10_000, cacheRead: 0, costMicroUsd: 200_000 });
    await runBatch(world, "findings", (id) => (id === "s0" ? SLOW : COST), tracker, dec(14, 4));
    expect(world.gate.claude.batches.map((b) => b.requests.map((r) => r.custom_id))).toEqual([["s0", "c0"]]);
    expect(await rows(world.d1.DB, "SELECT kind FROM findings ORDER BY kind")).toEqual([{ kind: "cost" }, { kind: "slow" }]);
  });

  it("遅い所を直した効き目は、目安を超えた呼び出しの回数で比べる", async () => {
    useRepo(world);
    await addToolCalls(world, { at: dec(3, 10), tool: "Bash", ms: [61_000, 61_000, 61_000, 61_000] });
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => SLOW, tracker, dec(7, 4));
    const fixed = dec(8, 12);
    await markFixed(world.gate.env, REPO, 1, fixed);
    // 直した後は目安を超えたのが 1 回。目安の内の呼び出しは数えない
    await addToolCalls(world, { at: fixed + DAY, tool: "Bash", ms: [61_000, 1_000, 1_000] });
    await addToolCalls(world, { at: fixed + DAY, tool: "Read", ms: [61_000, 61_000] });
    await checkEffects(world.gate.env, tracker, fixed + 7 * DAY);
    expect(await rows(world.d1.DB, "SELECT status, effect FROM findings")).toEqual([{ status: "verified", effect: JSON.stringify({ before: 4, after: 1 }) }]);
  });

  it("無駄な費用を直した効き目は、割引が当たらなかった呼び出しの回数で比べ、減らなければ戻すタスクを足す", async () => {
    useRepo(world);
    await addUsage(world, { at: dec(3, 10), staffId: "builder", count: 10, input: 10_000, cacheRead: 0, costMicroUsd: 200_000 });
    const tracker = fakeTracker();
    await runBatch(world, "findings", () => COST, tracker, dec(7, 4));
    const fixed = dec(8, 12);
    await markFixed(world.gate.env, REPO, 1, fixed);
    await addUsage(world, { at: fixed + DAY, staffId: "builder", count: 10, input: 10_000, cacheRead: 0, costMicroUsd: 200_000 });
    await addUsage(world, { at: fixed + DAY, staffId: "reviewer", count: 10, input: 10_000, cacheRead: 0, costMicroUsd: 200_000 });
    await checkEffects(world.gate.env, tracker, fixed + 7 * DAY);
    expect(await rows(world.d1.DB, "SELECT status, effect FROM findings")).toEqual([{ status: "reverted", effect: JSON.stringify({ before: 10, after: 10 }) }]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM nodes WHERE kind = 'task'")).toEqual([{ n: 1 }]);
  });
});
