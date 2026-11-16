// 5 分ごとの定期ジョブが、社員ごとに alarm を掛け、持っているタスクの呼び出しを始めさせる事を確かめる (社員と勤怠の 3.2)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScheduled } from "../../src/gate/jobs/health.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const clock = fixedClock(Date.UTC(2026, 10, 16, 0, 0, 0));
let d1: TestD1;
let gate: TestGate;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
});
afterEach(() => d1.dispose());

/**
 * 社員 DO の arm の呼び出しを数える env を作る
 * @param environment ENVIRONMENT の値
 * @param failing arm が落ちる社員
 * @returns env と、arm を呼んだ社員の並び
 */
function armedEnv(environment: string | undefined, failing?: string): { env: typeof gate.env; armed: string[] } {
  const armed: string[] = [];
  const staff = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      arm: () => {
        armed.push(name);
        return name === failing ? Promise.reject(new Error("社員 DO が応答しない")) : Promise.resolve({ alarm: null });
      },
    }),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const env = { ...gate.env, STAFF: staff, ENVIRONMENT: environment } as unknown as typeof gate.env;
  return { env, armed };
}

/**
 * 定期ジョブを走らせ、待たせた物をすべて待つ
 * @param env バインディング
 */
async function run(env: typeof gate.env): Promise<void> {
  const waits: Promise<unknown>[] = [];
  runScheduled(env, { waitUntil: (p: Promise<unknown>) => waits.push(p) }, clock);
  await Promise.all(waits);
}

describe("社員の alarm を定期ジョブで掛ける", () => {
  it("3 人の社員 DO の arm を呼び、1 人が落ちてもほかを呼んでエラーログに残す", async () => {
    const { env, armed } = armedEnv("production", "builder");
    await run(env);
    expect(armed.toSorted()).toEqual(["builder", "president", "reviewer"]);
    const { results } = await d1.REC_2026.prepare("SELECT source, code FROM error_events WHERE code LIKE 'staff_%'").all();
    expect(results).toEqual([{ source: "job", code: "staff_arm_failed" }]);
  });

  it("プレビューでは arm を呼ばない", async () => {
    const { env, armed } = armedEnv("preview");
    await run(env);
    expect(armed).toEqual([]);
  });
});
