// 同じ GitHub のレビューを配信 ID を替えて受け直しても、作った社員のタスクの出来事は 1 行で、オフィスの出来事も 1 度だけ配り、画面で変えたオーナーの判断を戻さない (タスクとレビューの 3.2、画面の全体の 3.2)
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hook } from "../helpers/github.ts";
import { eventsOf, HEAD, openReview, reviewHook } from "../helpers/review.ts";
import { advance, api, MINUTE, rows, useWork } from "../helpers/work.ts";

const world = useWork();

const Work = z.object({ type: z.literal("work"), work: z.object({ nodeId: z.string() }).loose() }).strict();

/**
 * 配ったオフィスの出来事の印のうち、1 つのタスクの物を返す
 * @param task タスク ID
 * @returns 出来事の印の中身
 */
function workMarksOf(task: string): unknown[] {
  return world.gate.live.published.flatMap((e) => {
    const mark = Work.safeParse(e);
    return mark.success && mark.data.work.nodeId === task ? [mark.data.work] : [];
  });
}

/**
 * 今年の記録の D1 で、SQL に印を含む文を作る時に落とす
 * @param mark SQL に含む印
 * @returns 元に戻す関数
 */
function failRecords(mark: string): () => void {
  const real = world.gate.env.REC_2026;
  if (!real) throw new Error("今年の記録の D1 が無い");
  const prepare = real.prepare.bind(real);
  const wrapped = {
    prepare: (sql: string): D1PreparedStatement => {
      if (sql.includes(mark)) throw new Error("記録の D1 に書けない");
      return prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => real.batch(statements),
    exec: (query: string) => real.exec(query),
    dump: () => real.dump(),
    withSession: (constraint?: string) => real.withSession(constraint),
  };
  // D1 のうち、ゲートウェイの使うメソッドだけを持つ包み
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  world.gate.env.REC_2026 = wrapped as unknown as D1Database;
  return () => {
    world.gate.env.REC_2026 = real;
  };
}

describe("GitHub のレビューを受け直す", () => {
  for (const [label, state, kind] of [
    ["不可", "changes_requested", "review_rejected"],
    ["可", "approved", "owner_approved"],
  ] as const) {
    it(`同じレビューの${label}の通知が配信 ID を替えて 2 度届いても、タスクの出来事は 1 行で、オフィスの出来事も 1 度だけ配る`, async () => {
      const { c, task } = await openReview(world);
      world.gate.live.published.length = 0;
      const payload = reviewHook(c, state, "直す");
      expect((await hook(world, { event: "pull_request_review", payload, secret: c.webhookSecret, delivery: crypto.randomUUID() })).status).toBe(204);
      // GitHub の送り直しは時刻が離れ、本文の細部も変わり得るので、配信 ID と本文の SHA-256 では見分けられない
      await advance(world, world.clock.now() + 5 * MINUTE);
      expect((await hook(world, { event: "pull_request_review", payload: { ...payload, sender: { login: "example", type: "User", id: 2 } }, secret: c.webhookSecret, delivery: crypto.randomUUID() })).status).toBe(204);
      expect((await eventsOf(world, task)).filter((e) => e.kind === kind)).toHaveLength(1);
      expect(workMarksOf(task)).toHaveLength(1);
    });
  }

  it("同じレビューの通知が配信 ID を替えて同時に 2 度届いても、タスクの出来事は 1 行で、オフィスの出来事も 1 度だけ配る", async () => {
    const { c, task } = await openReview(world);
    world.gate.live.published.length = 0;
    const payload = reviewHook(c, "changes_requested", "直す");
    const statuses = await Promise.all([
      hook(world, { event: "pull_request_review", payload, secret: c.webhookSecret, delivery: crypto.randomUUID() }),
      hook(world, { event: "pull_request_review", payload: { ...payload, sender: { login: "example", type: "User", id: 2 } }, secret: c.webhookSecret, delivery: crypto.randomUUID() }),
    ]);
    expect(statuses.map((r) => r.status)).toEqual([204, 204]);
    expect((await eventsOf(world, task)).filter((e) => e.kind === "review_rejected")).toHaveLength(1);
    expect(workMarksOf(task)).toHaveLength(1);
  });

  it("同じ先に別のオーナーのレビューが続けて届けば、それぞれを出来事に残す", async () => {
    const { c, task } = await openReview(world);
    await hook(world, { event: "pull_request_review", payload: reviewHook(c, "changes_requested", "直す"), secret: c.webhookSecret });
    const again = reviewHook(c, "changes_requested", "もう一度直す");
    await hook(world, { event: "pull_request_review", payload: { ...again, review: { ...again.review, id: 9002 } }, secret: c.webhookSecret, delivery: crypto.randomUUID() });
    expect((await eventsOf(world, task)).filter((e) => e.kind === "review_rejected").map((e) => e.detail["githubReviewId"])).toEqual([9001, 9002]);
  });

  it("出来事を書けずに落ちたレビューの通知は、送り直しで出来事を 1 行足し、オフィスの出来事を 1 度配る", async () => {
    const { c, task } = await openReview(world);
    world.gate.live.published.length = 0;
    const payload = reviewHook(c, "changes_requested", "直す");
    const restore = failRecords('insert into "node_events"');
    const failed = await hook(world, { event: "pull_request_review", payload, secret: c.webhookSecret, delivery: crypto.randomUUID() });
    restore();
    expect(failed.status).toBe(500);
    await advance(world, world.clock.now() + 5 * MINUTE);
    expect((await hook(world, { event: "pull_request_review", payload, secret: c.webhookSecret, delivery: crypto.randomUUID() })).status).toBe(204);
    expect((await eventsOf(world, task)).filter((e) => e.kind === "review_rejected")).toHaveLength(1);
    expect(workMarksOf(task)).toHaveLength(1);
  });

  for (const [label, state, screen] of [
    ["可", "approved", "request_changes"],
    ["不可", "changes_requested", "approve"],
  ] as const) {
    it(`GitHub の${label}を写した後に画面で判断を変えれば、同じ${label}の通知を配信 ID を替えて受け直しても、画面の判断のまま残る`, async () => {
      const { c, task } = await openReview(world);
      const payload = reviewHook(c, state, "見た");
      expect((await hook(world, { event: "pull_request_review", payload, secret: c.webhookSecret, delivery: crypto.randomUUID() })).status).toBe(204);
      await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: screen, body: "変える", baseSha: HEAD });
      await advance(world, world.clock.now() + 5 * MINUTE);
      // 送り直しは本文の細部も変わり得るので、本文の SHA-256 では見分けられない形にする
      const again = { ...payload, sender: { login: "example", type: "User", id: 2 } };
      expect((await hook(world, { event: "pull_request_review", payload: again, secret: c.webhookSecret, delivery: crypto.randomUUID() })).status).toBe(204);
      expect(await rows(world.d1.DB, "SELECT owner_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ owner_verdict: screen }]);
    });
  }
});
