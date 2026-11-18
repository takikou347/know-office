// レビューを GitHub に写す時に GitHub の上限に当たったら、回数に数えず、待つ時刻まで写し直さない (タスクとレビューの 3.2)
import { describe, expect, it } from "vitest";
import { retryMirrors, sendMirror } from "../../src/gate/github/mirror.ts";
import { wrapDb } from "../helpers/github.ts";
import { api, MINUTE, REPO, rows, useWork } from "../helpers/work.ts";
import { HEAD, openReview, postedTo } from "../helpers/review.ts";

const world = useWork();

/**
 * 写す行の送った回数と、送る者の印を読む
 * @returns 回数と印
 */
async function mirrorRow(): Promise<{ id: string; attempts: number; claimed: number | null }> {
  const [row] = await rows(world.d1.DB, "SELECT id, attempts, claimed_until FROM github_mirrors");
  return { id: String(row?.["id"]), attempts: Number(row?.["attempts"]), claimed: row?.["claimed_until"] === null ? null : Number(row?.["claimed_until"]) };
}

/**
 * 今より後に足されたエラーログの code
 * @param before 前に読んだ数
 * @returns code の並び
 */
async function newErrors(before: number): Promise<unknown[]> {
  return (await rows(world.d1.REC_2026, "SELECT code FROM error_events")).slice(before).map((r) => r["code"]);
}

describe("GitHub の上限に当たった写し", () => {
  it("GitHub の上限に当たったら、待つ時刻まで写し直さず、送った回数に数えない", async () => {
    const { task, forge } = await openReview(world);
    const before = (await rows(world.d1.REC_2026, "SELECT code FROM error_events")).length;
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/comments`, 429, { "retry-after": "900" });
    await api(world, "POST", `/api/v1/reviews/${task}/notes`, { path: "src/a.ts", line: 1, side: "new", body: "ここ" }, 201);
    expect((await mirrorRow()).attempts).toBe(0);
    expect(await newErrors(before)).toEqual(["github_mirror_rate_limited"]);
    // 写しもゲートウェイから GitHub への口なので、レート制限の通知を出す (サービスと拡張の 3.5)
    const notices = await rows(world.d1.DB, "SELECT level, body FROM notices WHERE kind = 'github_rate_limited'");
    expect(notices.map((n) => ({ level: n["level"], wait: String(n["body"]).includes("900 秒後") }))).toEqual([{ level: "warn", wait: true }]);
    // 15 分の待ちの間は、5 分ごとの写し直しでも送らない
    world.clock.advance(10 * MINUTE);
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 0, failed: 0 });
    expect(postedTo(world, "comments")).toHaveLength(1);
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 1, failed: 0 });
    expect(postedTo(world, "comments")).toHaveLength(2);
  });

  it("12 回目で上限に当たっても諦めず、回数を 11 に戻して待ちの後に写す", async () => {
    const { task, forge } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 500);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    await world.d1.DB.prepare("UPDATE github_mirrors SET attempts = 11").run();
    const before = (await rows(world.d1.REC_2026, "SELECT code FROM error_events")).length;
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 429, { "retry-after": "300" });
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 0, failed: 1 });
    expect((await mirrorRow()).attempts).toBe(11);
    expect(await newErrors(before)).toEqual(["github_mirror_rate_limited"]);
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 1, failed: 0 });
  });

  it("待ちの間に 2 つ同時に送ろうとしても取らず、待ちの後に 2 つ同時でも 1 度だけ送る", async () => {
    const { task, forge } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 429, { "retry-after": "120" });
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    const { id } = await mirrorRow();
    const during = await Promise.all([sendMirror(world.gate.env, forge, id, world.clock), sendMirror(world.gate.env, forge, id, world.clock)]);
    expect(during).toEqual(["skipped", "skipped"]);
    world.clock.advance(2 * MINUTE);
    const after = await Promise.all([sendMirror(world.gate.env, forge, id, world.clock), sendMirror(world.gate.env, forge, id, world.clock)]);
    expect(after.toSorted()).toEqual(["sent", "skipped"]);
    expect((await mirrorRow()).attempts).toBe(1);
    expect(world.gate.github.sent).toHaveLength(1);
  });

  it("送る間に印が切れて別の者が取り直していたら、上限に当たっても別の者の印と回数を変えない", async () => {
    const { task, forge } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 500);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    world.clock.advance(5 * MINUTE);
    const { id } = await mirrorRow();
    const other = world.clock.now() + 10 * MINUTE;
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 429, { "retry-after": "60" });
    // 送る者が GitHub を呼ぶ前に、印が切れて別の者が取り直した形にする
    const restore = wrapDb(world, {
      prepare: (real, sql) => {
        if (sql.startsWith("SELECT repo, pr_number, head_sha, owner_verdict FROM reviews")) void real("UPDATE github_mirrors SET claimed_until = ?, attempts = attempts + 1").bind(other).run();
        return real(sql);
      },
    });
    try {
      expect(await sendMirror(world.gate.env, forge, id, world.clock)).toBe("failed");
    } finally {
      restore();
    }
    expect(await mirrorRow()).toMatchObject({ attempts: 3, claimed: other });
  });
});
