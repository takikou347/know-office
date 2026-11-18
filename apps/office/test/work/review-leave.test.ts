// レビュー担当が判断の後にタスクを離れる所で落ちても、main に入れる所の元の失敗を隠さず、離れる所の失敗をエラーログに残す事を確かめる (タスクとレビューの 3.1)
import { describe, expect, it } from "vitest";
import { recordsOf } from "../../src/gate/work/nodes.ts";
import { HEAD, openReview } from "../helpers/review.ts";
import { tool } from "../helpers/review-again.ts";
import { REPO, rows, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });

describe("別のモデルによる確認", () => {
  it("判断の後に main に入れる所とタスクを離れる所の両方で落ちても、元の失敗を返し、離れる所の失敗をエラーログに残す", async () => {
    await openReview(world);
    world.gate.github.failNext(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, 500);
    // 社員 DO の終わりの知らせだけを落とす
    const staffNs = world.gate.env.STAFF;
    const broken = {
      idFromName: staffNs.idFromName.bind(staffNs),
      get: (id: Parameters<typeof staffNs.get>[0]) => {
        const real = staffNs.get(id);
        return new Proxy(real, { get: (target, key): unknown => (key === "finish" ? () => Promise.reject(new Error("届かない")) : Reflect.get(target, key)) });
      },
    };
    Object.assign(world.gate.env, { STAFF: broken });
    try {
      await expect(tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "確かめた", headSha: HEAD })).rejects.toMatchObject({ code: "upstream_failed" });
    } finally {
      Object.assign(world.gate.env, { STAFF: staffNs });
    }
    expect(await rows(recordsOf(world.gate.env, world.clock.now()), "SELECT code FROM error_events WHERE code = 'review_leave_failed'")).toEqual([{ code: "review_leave_failed" }]);
  });
});
