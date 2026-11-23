// アイデア出しの週のバッチ処理。費用が出るので IDEA_BATCH が on の時だけ、月曜 4 時の Cron で社長のモデルに今のサービスを送り、返った案をアイデアの段階に足す (サービスと拡張の 3.1、3.6)
import { SONNET } from "@know-office/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DAILY_CRON } from "../../src/gate/jobs/daily.ts";
import { IDEAS_PER_BATCH } from "../../src/gate/jobs/ideas.ts";
import { DISTILL_CRON, FINDINGS_CRON, pollBatches, runWeekly, startBatch } from "../../src/gate/jobs/weekly.ts";
import { rows } from "../helpers/work.ts";
import { answerJson, dec, fakeTracker, onNextBatch, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const IDEA = { title: "勤怠の CSV を読む小さな道具", kind: "library", aim: "月末の集計を早くする", users: "小さな会社の事務の人" };

describe("アイデア出し", () => {
  it("IDEA_BATCH が off の間は、週の Cron でアイデア出しを送らない", async () => {
    const waits: Promise<unknown>[] = [];
    expect(runWeekly(FINDINGS_CRON, world.gate.env, { waitUntil: (p) => void waits.push(p) }, { now: () => dec(7, 4) }, { fetch: world.gate.fetch, tracker: fakeTracker() })).toBe(true);
    await Promise.all(waits);
    expect(world.gate.claude.batches).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT kind FROM batches")).toEqual([]);
  });

  it("on にすると、月曜 4 時の Cron で 1 件の要求を社長のモデルで送り、5 分ごとの定期ジョブが返った案をアイデアの段階に足す", async () => {
    world.gate.env.IDEA_BATCH = "on";
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    const waits: Promise<unknown>[] = [];
    expect(runWeekly(FINDINGS_CRON, world.gate.env, { waitUntil: (p) => void waits.push(p) }, { now: () => dec(7, 4) }, deps)).toBe(true);
    await Promise.all(waits);
    const batch = world.gate.claude.batches.find((b) => b.requests.some((r) => r.custom_id === "ideas"));
    expect(batch?.requests.map((r) => [r.custom_id, r.params.model])).toEqual([["ideas", SONNET]]);
    // 今のサービス (マイグレーションが置く knowidea-ui など) を渡し、重ならない案を求める
    expect(JSON.stringify(batch?.requests[0]?.params.messages)).toContain("knowidea-ui");
    world.gate.claude.endBatch(batch?.id ?? "", () => answerJson({ ideas: [IDEA] }, { input_tokens: 500, output_tokens: 100 }));
    await pollBatches(world.gate.env, deps, dec(7, 4, 5));
    expect(await rows(world.d1.DB, "SELECT name, kind, stage, aim, users FROM services WHERE stage = 'idea'")).toEqual([
      { name: IDEA.title, kind: "library", stage: "idea", aim: IDEA.aim, users: IDEA.users },
    ]);
    expect(await rows(world.d1.DB, "SELECT kind, by FROM service_events WHERE by = 'president'")).toEqual([{ kind: "stage", by: "president" }]);
    expect(await rows(world.d1.DB, "SELECT kind, status FROM batches WHERE kind = 'ideas'")).toEqual([{ kind: "ideas", status: "applied" }]);
    expect(await rows(world.d1.REC_2026, "SELECT staff_id, scope, model FROM usage")).toEqual([{ staff_id: "president", scope: "office", model: SONNET }]);
  });

  it(`形の違う案は入れず、1 回に ${String(IDEAS_PER_BATCH)} 件までを入れ、同じ週は 2 度送らない`, async () => {
    world.gate.env.IDEA_BATCH = "on";
    const tracker = fakeTracker();
    const many = Array.from({ length: IDEAS_PER_BATCH + 2 }, (_, i) => ({ ...IDEA, title: `案 ${String(i)}` }));
    await runBatch(world, "ideas", () => answerJson({ ideas: [{ ...IDEA, title: "形の違う案", kind: "game" }, ...many] }), tracker, dec(7, 4));
    expect((await rows(world.d1.DB, "SELECT name FROM services WHERE stage = 'idea' ORDER BY name")).map((r) => r.name)).toEqual(many.slice(0, IDEAS_PER_BATCH).map((i) => i.title));
    const before = world.gate.claude.batches.length;
    expect(await startBatch(world.gate.env, "ideas", { fetch: world.gate.fetch, tracker }, dec(8, 4))).toBeNull();
    expect(world.gate.claude.batches.length).toBe(before);
  });

  it("結果を入れる途中で落ちたら案を残さず、次に読み直して 1 度だけ入れる", async () => {
    world.gate.env.IDEA_BATCH = "on";
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    await startBatch(world.gate.env, "ideas", deps, dec(7, 4));
    const batch = world.gate.claude.batches.at(-1);
    world.gate.claude.endBatch(batch?.id ?? "", () => answerJson({ ideas: [IDEA] }));
    onNextBatch(world, () => Promise.reject(new Error("D1 が落ちた")));
    await pollBatches(world.gate.env, deps, dec(7, 4, 5));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM services WHERE stage = 'idea'")).toEqual([{ n: 0 }]);
    await pollBatches(world.gate.env, deps, dec(7, 4, 10));
    await pollBatches(world.gate.env, deps, dec(7, 4, 15));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM services WHERE stage = 'idea'")).toEqual([{ n: 1 }]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM service_events WHERE by = 'president'")).toEqual([{ n: 1 }]);
  });
});

describe("週の Cron", () => {
  it("wrangler.jsonc の triggers.crons に 5 分ごと、毎日、週の 2 本があり、週の 2 本は週のバッチ処理が受ける", () => {
    // JSONC の行のコメントだけを外して読む
    const config = z.object({ triggers: z.object({ crons: z.array(z.string()) }) }).loose().parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8").replaceAll(/^\s*\/\/.*$/gm, "")));
    expect(config.triggers.crons.toSorted()).toEqual(["*/5 * * * *", DAILY_CRON, DISTILL_CRON, FINDINGS_CRON].toSorted());
    const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) };
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    expect(config.triggers.crons.filter((cron) => runWeekly(cron, world.gate.env, ctx, { now: () => dec(13, 4) }, deps)).toSorted()).toEqual([DISTILL_CRON, FINDINGS_CRON].toSorted());
  });
});
