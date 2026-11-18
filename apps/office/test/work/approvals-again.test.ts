// 承認の答えの後。差し戻しを直して出し直す、社員の追加は増えない事を答えに書く、出来事が書けなくても決定とタスクの戻しは残る (タスクとレビューの 3.1、3.4)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { recordsOf } from "../../src/gate/work/nodes.ts";
import { Answer, ApprovalRow, asked, finishCurrent, startedDetails, statusOf } from "../helpers/approvals.ts";
import { api, clockIn, purposeAndGoal, rows, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/**
 * 今の年の記録の D1 で、タスクの出来事を足す文だけを落とす。エラーログは同じ D1 に書けるようにする
 * @param w テストの物
 * @returns 元に戻す関数
 */
function failNodeEvents(w: WorkWorld): () => void {
  const real = recordsOf(w.gate.env, w.clock.now());
  const name = Object.entries(w.gate.env).find(([, v]) => v === real)?.[0] ?? "";
  const prepare = real.prepare.bind(real);
  const wrapped = new Proxy(real, {
    get: (target, key) => {
      if (key === "prepare") {
        return (sql: string) => {
          if (/insert\s+into\s+"?node_events"?/i.test(sql)) throw new Error("出来事を書けない");
          return prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, key);
      const bound: unknown = typeof value === "function" ? value.bind(target) : value;
      return bound;
    },
  });
  const env: Record<string, unknown> = w.gate.env;
  env[name] = wrapped;
  return () => {
    env[name] = real;
  };
}

describe("オーナーに上げる事", () => {
  it("差し戻しの後に、理由を変えて出し直すと新しい承認を立て、同じ理由なら差し戻しを返す", async () => {
    const { approvalId } = await asked(world, "cost_increase");
    await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "reject", reason: "無料の枠で作る" });
    await finishCurrent(world);
    const same = await tool(world, "builder", "ask_owner", { kind: "cost_increase", target: "Workers の有料プラン", reason: "要件に要る" });
    expect(Answer.parse(JSON.parse(same.content))).toEqual({ approvalId, status: "rejected", reason: "無料の枠で作る" });

    const again = Answer.parse(JSON.parse((await tool(world, "builder", "ask_owner", { kind: "cost_increase", target: "Workers の有料プラン", reason: "無料の枠では 1 日の上限に届く" })).content));
    expect(again.status).toBe("pending");
    expect(again.approvalId).not.toBe(approvalId);
    const pending = z.array(ApprovalRow).parse(await api(world, "GET", "/api/v1/approvals?status=pending"));
    expect(pending.map((a) => a.id)).toEqual([again.approvalId]);
  });
});

describe("組織図", () => {
  it("社員の追加を求めると、社員は増えない事を答えに書く", async () => {
    await purposeAndGoal(world);
    await clockIn(world, "president", "builder");
    await staffOf(world, "builder").pull(world.clock.now());
    await staffOf(world, "president").pull(world.clock.now());
    const res = await tool(world, "president", "staff_request", { kind: "staff_add", role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" });
    expect(JSON.parse(res.content)).toMatchObject({ status: "pending", note: "社員は 3 人に決まっていて、承認しても増えない" });
  });
});

describe("承認の決まり", () => {
  it("出来事を書けなくても、承認とタスクの戻しは残り、エラーログに残し、社員は取り直して答えを読む", async () => {
    const { approvalId, nodeId } = await asked(world, "cost_increase");
    const restore = failNodeEvents(world);
    try {
      expect(await api(world, "POST", `/api/v1/approvals/${approvalId}/decision`, { decision: "reject", reason: "無料の枠で作る" })).toMatchObject({ status: "rejected" });
    } finally {
      restore();
    }
    expect(await statusOf(world, "approvals", approvalId)).toBe("rejected");
    expect(await statusOf(world, "nodes", nodeId)).toBe("todo");
    const recs = recordsOf(world.gate.env, world.clock.now());
    expect(await rows(recs, "SELECT level, code FROM error_events WHERE code = 'approval_follow_failed'")).toEqual([{ level: "warn", code: "approval_follow_failed" }]);
    // 知らせが届かなくても、待つ間のタスクを終えれば取り直し、始めの中身に答えが入る
    await finishCurrent(world);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).nodeId).toBe(nodeId);
    expect((await startedDetails(world, nodeId)).at(-1)).toMatchObject({ approval: { id: approvalId, status: "rejected", reason: "無料の枠で作る" } });
  });
});
