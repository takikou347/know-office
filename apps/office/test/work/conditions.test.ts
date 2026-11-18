// main に入れる条件とデプロイの条件に共通の確かめ (GitHub の連携の 3.3)
import { describe, expect, it } from "vitest";
import { checkConditions } from "../../src/gate/work/conditions.ts";
import type { Forge } from "../../src/gate/work/loop.ts";

/**
 * チェックの今だけ答える GitHub の代わり
 * @param state チェックの今
 * @param calls チェックを読んだ回数を数える入れ物
 * @param calls.n 回数
 * @returns GitHub の代わり
 */
function forgeWith(state: "passed" | "failed" | "pending", calls: { n: number }): Pick<Forge, "checkState"> {
  return {
    checkState: () => {
      calls.n += 1;
      return Promise.resolve(state);
    },
  };
}

const target = { repo: "example/app", sha: "b".repeat(40) };

describe("条件の確かめ", () => {
  it("条件がそろえば met で、チェックは求める時だけ読む", async () => {
    const calls = { n: 0 };
    expect(await checkConditions(forgeWith("passed", calls), ["checks", "reviewer"], target, { reviewer: true, owner: false })).toEqual({ kind: "met" });
    expect(calls.n).toBe(1);
    expect(await checkConditions(forgeWith("failed", calls), ["reviewer"], target, { reviewer: true, owner: false })).toEqual({ kind: "met" });
    expect(calls.n).toBe(1);
  });

  it("承認が足りない間は、GitHub にチェックを聞かずに待つ", async () => {
    const calls = { n: 0 };
    expect(await checkConditions(forgeWith("passed", calls), ["checks", "reviewer", "owner"], target, { reviewer: false, owner: false })).toEqual({ kind: "waiting", missing: ["reviewer", "owner"] });
    expect(calls.n).toBe(0);
  });

  it("チェックが落ちていれば failed、終わっていなければ checks を待つ", async () => {
    const calls = { n: 0 };
    expect(await checkConditions(forgeWith("failed", calls), ["checks"], target, { reviewer: true, owner: true })).toEqual({ kind: "failed", missing: [] });
    expect(await checkConditions(forgeWith("pending", calls), ["checks"], target, { reviewer: true, owner: true })).toEqual({ kind: "waiting", missing: ["checks"] });
  });

  it("all を付けると、承認が足りなくてもチェックを読み、足りない条件を全部返す", async () => {
    const calls = { n: 0 };
    const none = { reviewer: false, owner: false };
    expect(await checkConditions(forgeWith("pending", calls), ["checks", "reviewer"], target, none, { all: true })).toEqual({ kind: "waiting", missing: ["checks", "reviewer"] });
    expect(calls.n).toBe(1);
    expect(await checkConditions(forgeWith("failed", calls), ["checks", "reviewer"], target, none, { all: true })).toEqual({ kind: "failed", missing: ["reviewer"] });
  });
});
