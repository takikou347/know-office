// 毎年 12 月 1 日に、5 年先の年の記録の置き場が結ばれているかを毎日の定期ジョブが確かめ、無ければ通知と Issue を出す (ログインと記録の 3.5)
import { describe, expect, it } from "vitest";
import { checkFutureYears } from "../../src/gate/jobs/daily.ts";
import { rows } from "../helpers/work.ts";
import { dec, fakeTracker, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();
const REPO = "example/know-office";

/**
 * 置き場の通知を読む
 * @returns notices の行
 */
function storageNotices(): Promise<Record<string, unknown>[]> {
  return rows(world.d1.DB, "SELECT kind, title FROM notices WHERE kind = 'storage' ORDER BY id");
}

describe("5 年先の記録の置き場", () => {
  it("12 月 1 日に 5 年先の置き場が結ばれていなければ、通知と Issue を 1 つずつ出し、読むまで重ねない", async () => {
    world.gate.env.OFFICE_REPO = REPO;
    const tracker = fakeTracker();
    await checkFutureYears(world.gate.env, tracker, { now: () => dec(1, 0, 5) });
    await checkFutureYears(world.gate.env, tracker, { now: () => dec(1, 0, 5) + 60_000 });
    expect(await storageNotices()).toEqual([{ kind: "storage", title: "記録の置き場 REC_2031 がまだ結ばれていない" }]);
    expect(tracker.issues.map((i) => [i.repo, i.title])).toEqual([[REPO, "記録の置き場 REC_2031 がまだ結ばれていない"]]);
  });

  it("5 年先の置き場が結ばれていれば何も出さない", async () => {
    world.gate.env.OFFICE_REPO = REPO;
    world.gate.env.REC_2031 = world.d1.REC_2027;
    const tracker = fakeTracker();
    await checkFutureYears(world.gate.env, tracker, { now: () => dec(1, 0, 5) });
    expect(await storageNotices()).toEqual([]);
    expect(tracker.issues).toEqual([]);
  });

  it("12 月 1 日でない日は確かめない", async () => {
    const tracker = fakeTracker();
    await checkFutureYears(world.gate.env, tracker, { now: () => dec(2, 0, 5) });
    expect(await storageNotices()).toEqual([]);
  });

  it("Issue を作れない時とリポジトリが無い時も通知は出し、作れなかった事をエラーログに残す", async () => {
    world.gate.env.OFFICE_REPO = REPO;
    const tracker = fakeTracker();
    tracker.down = true;
    await checkFutureYears(world.gate.env, tracker, { now: () => dec(1, 0, 5) });
    expect(await storageNotices()).toHaveLength(1);
    expect(await rows(world.d1.REC_2026, "SELECT code FROM error_events")).toEqual([{ code: "record_year_issue_failed" }]);
  });
});
