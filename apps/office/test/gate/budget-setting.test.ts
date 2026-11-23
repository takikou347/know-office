// Claude の API の月の予算の設定。増やす変更はパスキーで確かめ、同じ版の 2 つの変更の片方を断る (社員が考えるの 3.10)
import { describe, expect, it } from "vitest";
import { api, type WorkWorld, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * 予算を送る
 * @param w テストの物
 * @param value 値
 * @param version 読んだ版
 * @param status 待つステータス
 * @returns 返事の本文
 */
function putBudget(w: WorkWorld, value: unknown, version: number, status = 200): Promise<unknown> {
  return api(w, "PUT", "/api/v1/settings/claude.budget", { version, value, reason: "予算" }, status);
}

describe("月の予算の設定", () => {
  it("減らす変更は確かめずに変え、一覧に出す", async () => {
    expect(await putBudget(world, { monthlyUsd: 50, taskMaxUsd: 0.5 }, 0)).toMatchObject({ key: "claude.budget", value: { monthlyUsd: 50, taskMaxUsd: 0.5 }, version: 1 });
    const listed = await api(world, "GET", "/api/v1/settings?limit=100");
    expect(JSON.stringify(listed)).toContain('"monthlyUsd":50');
  });

  it("増やす変更はパスキーの確認が無ければ断る", async () => {
    expect(await putBudget(world, { monthlyUsd: 95, taskMaxUsd: 1 }, 0, 401)).toMatchObject({ code: "step_up_required" });
    expect(await putBudget(world, { monthlyUsd: 90, taskMaxUsd: 2 }, 0, 401)).toMatchObject({ code: "step_up_required" });
  });

  it("同じ版の 2 つ目の変更は 409 にする", async () => {
    await putBudget(world, { monthlyUsd: 80, taskMaxUsd: 1 }, 0);
    expect(await putBudget(world, { monthlyUsd: 70, taskMaxUsd: 1 }, 0, 409)).toMatchObject({ code: "conflict" });
  });
});
