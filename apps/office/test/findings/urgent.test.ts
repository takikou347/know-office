// 急ぐ故障を見つけた時に調べる事。同じ原因のエラーが 5 分に 3 回を超えたら、週を待たずに 5 分ごとの定期ジョブがバッチ処理で調べて Issue にする (サービスと拡張の 3.7)
import type { Fetcher } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { fingerprintMark } from "../../src/gate/findings/tracker.ts";
import { pollBatches } from "../../src/gate/jobs/weekly.ts";
import { REPO, rows, type WorkWorld } from "../helpers/work.ts";
import { addErrors, answerJson, dec, fakeTracker, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const BURST = "e".repeat(64);
const ANSWER = answerJson({ title: "保存のたびに 500 を返す", steps: ["ノードを保存する"], needs: null, reason: "D1 の列が足りない" });

/**
 * 調べる先のリポジトリを決め、急ぐ故障の調べを入れる。入れるのはオーナーの はい の後
 * @param w テストの物
 */
function useRepo(w: WorkWorld): void {
  Object.assign(w.gate.env, { OFFICE_REPO: REPO, URGENT_SCAN: "on" });
}

/**
 * 違う原因の急ぐ故障を置く。1 分ごとに起きるので、5 分の間に 6 回まで置ける
 * @param counts 原因ごとの回数
 * @param at 最初の時刻
 * @param tag 指紋の頭の 1 字
 * @returns 指紋
 */
async function bursts(counts: number[], at: number, tag = "a"): Promise<string[]> {
  const prints = counts.map((_, i) => `${tag}${i.toString(16).padStart(63, "0")}`);
  for (const [i, fingerprint] of prints.entries()) await addErrors(world, { at, fingerprint, count: counts[i] ?? 0 });
  return prints;
}

/**
 * 送った急ぐ故障のバッチの指紋を読む
 * @returns 指紋
 */
async function sent(): Promise<string[]> {
  return (await rows(world.d1.DB, "SELECT week FROM batches WHERE kind = 'urgent' ORDER BY week")).map((r) => String(r["week"]).split(":")[1] ?? "");
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

describe("急ぐ故障の調べの費用の守り", () => {
  it("URGENT_SCAN が on でなければ送らない", async () => {
    Object.assign(world.gate.env, { OFFICE_REPO: REPO });
    await addErrors(world, { at: dec(3, 10), fingerprint: BURST, count: 4 });
    await poll(dec(3, 10, 5));
    Object.assign(world.gate.env, { URGENT_SCAN: "off" });
    await poll(dec(3, 10, 5));
    expect(world.gate.claude.batches).toEqual([]);
  });

  it("OFFICE_REPO が無ければ送らない", async () => {
    Object.assign(world.gate.env, { URGENT_SCAN: "on" });
    await addErrors(world, { at: dec(3, 10), fingerprint: BURST, count: 4 });
    await poll(dec(3, 10, 5));
    Object.assign(world.gate.env, { OFFICE_REPO: "not a repo" });
    await poll(dec(3, 10, 5));
    expect(world.gate.claude.batches).toEqual([]);
  });

  it("1 回に送るのは多い順に 3 原因まで", async () => {
    useRepo(world);
    const prints = await bursts([4, 4, 5, 6, 6], dec(3, 10));
    await poll(dec(3, 10, 5));
    expect(world.gate.claude.batches).toHaveLength(3);
    expect(await sent()).toEqual(prints.slice(2).toSorted((a, b) => a.localeCompare(b)));
  });

  it("1 日に送るのは 10 本までで、次の日はまた送る", async () => {
    useRepo(world);
    // 3 本ずつ 4 回見つける。4 回目は 10 本に届いた所で止める
    for (const [i, tag] of ["a", "b", "c", "d"].entries()) {
      await bursts([4, 4, 4], dec(3, 10 + i), tag);
      await poll(dec(3, 10 + i, 5));
    }
    expect(world.gate.claude.batches).toHaveLength(10);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches WHERE kind = 'urgent'")).toEqual([{ n: 10 }]);
    // 次の日は数え直す
    await bursts([4], dec(4, 10), "e");
    await poll(dec(4, 10, 5));
    expect(world.gate.claude.batches).toHaveLength(11);
  });

  it("同時に見つけても、1 日の 10 本を超えない", async () => {
    useRepo(world);
    for (const [i, tag] of ["a", "b", "c"].entries()) {
      await bursts([4, 4, 4], dec(3, 10 + i), tag);
      await poll(dec(3, 10 + i, 5));
    }
    expect(world.gate.claude.batches).toHaveLength(9);
    // 残り 1 本の所に、違う原因を見つけた 2 つの定期ジョブが同時に来る
    await bursts([4, 4], dec(3, 13), "d");
    await Promise.all([poll(dec(3, 13, 5)), poll(dec(3, 13, 5))]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches WHERE kind = 'urgent'")).toEqual([{ n: 10 }]);
  });

  it("送ったか分からない送りも 1 日の 10 本に数え、送り直さない", async () => {
    useRepo(world);
    // 本物に届いて作られたが、返事が時間切れで返らない
    const lost: Fetcher = async (url, init) => {
      await world.gate.fetch(url, init);
      throw new DOMException("時間切れ", "TimeoutError");
    };
    for (const [i, tag] of ["a", "b", "c", "d"].entries()) {
      await bursts([4, 4, 4], dec(3, 10 + i), tag);
      await pollBatches(world.gate.env, { fetch: lost, tracker: fakeTracker() }, dec(3, 10 + i, 5));
    }
    expect(await rows(world.d1.DB, "SELECT status, count(*) AS n FROM batches WHERE kind = 'urgent' GROUP BY status")).toEqual([{ status: "unknown", n: 10 }]);
    expect(world.gate.claude.batches).toHaveLength(10);
  });
});
