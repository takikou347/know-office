// 急ぐ故障を見つけた時に調べる事。同じ原因のエラーが 5 分に 3 回を超えたら、週を待たずに 5 分ごとの定期ジョブがバッチ処理で調べて Issue にする (サービスと拡張の 3.7)
import { describe, expect, it } from "vitest";
import { fingerprintMark } from "../../src/gate/findings/tracker.ts";
import { pollBatches } from "../../src/gate/jobs/weekly.ts";
import { REPO, rows, type WorkWorld } from "../helpers/work.ts";
import { addErrors, answerJson, dec, fakeTracker, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const BURST = "e".repeat(64);
const ANSWER = answerJson({ title: "保存のたびに 500 を返す", steps: ["ノードを保存する"], needs: null, reason: "D1 の列が足りない" });

/**
 * 調べる先のリポジトリを決める
 * @param w テストの物
 */
function useRepo(w: WorkWorld): void {
  Object.assign(w.gate.env, { OFFICE_REPO: REPO });
}

/**
 * 5 分ごとの定期ジョブを 1 回走らせる
 * @param at 時刻
 * @param tracker GitHub の Issue の代わり
 * @returns 終わるのを待つ Promise
 */
function poll(at: number, tracker = fakeTracker()): Promise<void> {
  return pollBatches(world.gate.env, { fetch: world.gate.fetch, tracker }, at);
}

describe("急ぐ故障", () => {
  it("同じ原因のエラーが 5 分に 3 回を超えたら、次の 5 分ごとの定期ジョブが調べ、その次に Issue にする", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(3, 10), fingerprint: BURST, count: 4 });
    const tracker = fakeTracker();
    await poll(dec(3, 10, 5), tracker);
    expect(world.gate.claude.batches.map((b) => b.requests.map((r) => r.custom_id))).toEqual([["u0"]]);
    expect(JSON.stringify(world.gate.claude.batches[0]?.requests[0]?.params.messages)).toContain("急ぐ故障");
    world.gate.claude.endBatch(world.gate.claude.batches[0]?.id ?? "", () => ANSWER);
    await poll(dec(3, 10, 10), tracker);
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]).toMatchObject({ repo: REPO, title: "保存のたびに 500 を返す" });
    expect(tracker.issues[0]?.body).toContain("急ぐ故障として、見つけた時に調べた");
    expect(tracker.issues[0]?.body).toContain("起きた回数: 4");
    expect(tracker.issues[0]?.body).toContain(fingerprintMark(BURST));
    // 同じ故障をその日のうちに 2 度調べない
    await addErrors(world, { at: dec(3, 11), fingerprint: BURST, count: 4 });
    await poll(dec(3, 11, 5), tracker);
    expect(world.gate.claude.batches).toHaveLength(1);

    // 週の調べは同じ Issue に回数を足し、急ぐ調べの分を 2 度数えない
    await runBatch(world, "findings", () => ANSWER, tracker, dec(7, 4));
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]?.comments.at(-1)).toContain("この週に 8 回、合わせて 8 回");
    expect(await rows(world.d1.DB, "SELECT kind, count FROM findings")).toEqual([{ kind: "error", count: 8 }]);
  });

  it("5 分に 3 回までと、warn と、Claude の API の失敗は急ぐ故障にしない", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(3, 10), fingerprint: BURST, count: 3 });
    await addErrors(world, { at: dec(3, 10), fingerprint: "f".repeat(64), count: 5, level: "warn" });
    await addErrors(world, { at: dec(3, 10), fingerprint: "9".repeat(64), count: 5, code: "claude_failed" });
    // 5 分より前に 4 回あっても、今の 5 分に 3 回を超えていなければ調べない
    await addErrors(world, { at: dec(3, 9), fingerprint: "8".repeat(64), count: 4 });
    await poll(dec(3, 10, 5));
    expect(world.gate.claude.batches).toEqual([]);
  });

  it("同時に 2 つの定期ジョブが見つけても、送るバッチは 1 つ", async () => {
    useRepo(world);
    await addErrors(world, { at: dec(3, 10), fingerprint: BURST, count: 4 });
    await Promise.all([poll(dec(3, 10, 5)), poll(dec(3, 10, 5))]);
    expect(world.gate.claude.batches).toHaveLength(1);
  });
});
