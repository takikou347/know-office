// 週のバッチ処理 (蒸留、見つけて直す調べ、アイデア出し) は費用が出るので、種類ごとの設定が on の時だけ送り、1 回に送る要求と週に送る回数の上限を数で持つ (サービスと拡張の 3.6)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DISTILL_CRON, FINDINGS_CRON, runWeekly, startBatch, WEEKLY_LIMITS } from "../../src/gate/jobs/weekly.ts";
import { rows } from "../helpers/work.ts";
import { addErrors, addStop, dec, fakeTracker, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

/**
 * 週の Cron を 2 本とも流し、待つ
 * @param at 時刻
 */
async function runBothCrons(at: number): Promise<void> {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
  for (const cron of [DISTILL_CRON, FINDINGS_CRON]) runWeekly(cron, world.gate.env, ctx, { now: () => at }, deps);
  await Promise.all(waits);
}

describe("週のバッチ処理の設定と上限", () => {
  it("DISTILL_BATCH と FINDINGS_BATCH と IDEA_BATCH が off なら、送る記録があっても週の Cron で何も送らない", async () => {
    Object.assign(world.gate.env, { DISTILL_BATCH: "off", FINDINGS_BATCH: "off", IDEA_BATCH: "off" });
    await addStop(world, { at: dec(2, 10), signal: "tool_burst" });
    await addErrors(world, { at: dec(2, 10), fingerprint: "a".repeat(64), count: 3 });
    await runBothCrons(dec(7, 4));
    expect(world.gate.claude.batches).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT kind FROM batches")).toEqual([]);
  });

  it("設定が無い時も off として扱う", async () => {
    Object.assign(world.gate.env, { DISTILL_BATCH: undefined, FINDINGS_BATCH: undefined, IDEA_BATCH: undefined });
    await addStop(world, { at: dec(2, 10), signal: "tool_burst" });
    await runBothCrons(dec(7, 4));
    expect(world.gate.claude.batches).toEqual([]);
  });

  it(`蒸留は 1 回に ${String(WEEKLY_LIMITS.distill.perRun)} 件の原因までを送る`, async () => {
    Object.assign(world.gate.env, { DISTILL_BATCH: "on" });
    for (let i = 0; i <= WEEKLY_LIMITS.distill.perRun; i += 1) await addStop(world, { at: dec(2, 10, i), signal: `signal_${String(i).padStart(2, "0")}` });
    await startBatch(world.gate.env, "distill", { fetch: world.gate.fetch, tracker: fakeTracker() }, dec(7, 3));
    expect(world.gate.claude.batches.at(-1)?.requests).toHaveLength(WEEKLY_LIMITS.distill.perRun);
  });

  it(`見つけて直す調べは 1 回に ${String(WEEKLY_LIMITS.findings.perRun)} 件の原因までを送る`, async () => {
    Object.assign(world.gate.env, { FINDINGS_BATCH: "on" });
    for (let i = 0; i <= WEEKLY_LIMITS.findings.perRun; i += 1) await addErrors(world, { at: dec(2, 10, i), fingerprint: String(i).padStart(64, "0"), count: 1 });
    await startBatch(world.gate.env, "findings", { fetch: world.gate.fetch, tracker: fakeTracker() }, dec(7, 4));
    expect(world.gate.claude.batches.at(-1)?.requests).toHaveLength(WEEKLY_LIMITS.findings.perRun);
  });

  it("同じ週は種類ごとに上限の回数までしか送らない", async () => {
    Object.assign(world.gate.env, { DISTILL_BATCH: "on" });
    await addStop(world, { at: dec(2, 10), signal: "tool_burst" });
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    await startBatch(world.gate.env, "distill", deps, dec(7, 3));
    await startBatch(world.gate.env, "distill", deps, dec(8, 3));
    expect(WEEKLY_LIMITS.distill.perWeek).toBe(1);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches WHERE kind = 'distill'")).toEqual([{ n: WEEKLY_LIMITS.distill.perWeek }]);
  });

  it("wrangler.jsonc の本番とプレビューの初期値は、どの週のバッチ処理も off", () => {
    const Vars = z.record(z.string(), z.string());
    const config = z
      .object({ vars: Vars, previews: z.object({ vars: Vars }).loose() })
      .loose()
      .parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8").replaceAll(/^\s*\/\/.*$/gm, "")));
    for (const vars of [config.vars, config.previews.vars]) {
      for (const limit of Object.values(WEEKLY_LIMITS)) expect(vars[limit.flag]).toBe("off");
    }
  });
});
