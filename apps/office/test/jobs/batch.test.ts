// 急がないタスクを、ワークスペースを起こさずにゲートウェイから Claude のバッチ処理で回す事。週に 1 度の蒸留を例に、始める、終わりを待つ、結果を入れるを確かめる (サービスと拡張の 3.6、monitoring の「トークンを減らす」)
import { costMicroUsd, OPUS } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { runScheduled } from "../../src/gate/jobs/health.ts";
import { DISTILL_CRON, FINDINGS_CRON, pollBatches, previousWeek, runWeekly, startBatch } from "../../src/gate/jobs/weekly.ts";
import { rows } from "../helpers/work.ts";
import { addErrors, addStop, answerJson, dec, fakeTracker, onNextBatch, runBatch, useWeekly, watchFetch } from "../helpers/weekly.ts";

const world = useWeekly();

const PROPOSAL = answerJson({ proposals: [{ kind: "prompt_rule", staffId: "builder", proposal: "main に push しない" }] }, { input_tokens: 1000, output_tokens: 200 });

describe("トークンを減らす", () => {
  it("急がないタスク", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await addStop(world, { at: dec(3, 10), signal: "token_rate" });
    const seen: string[] = [];
    const deps = { fetch: watchFetch(world.gate.fetch, seen), tracker: fakeTracker() };
    await startBatch(world.gate.env, "distill", deps, dec(7, 3));
    // 原因ごとに 1 件の要求を、レビュー担当のモデルで 1 つのバッチに入れて送る
    const [batch] = world.gate.claude.batches;
    expect(batch?.requests.map((r) => [r.params.model, r.custom_id])).toEqual([
      [OPUS, "c0"],
      [OPUS, "c1"],
    ]);
    world.gate.claude.endBatch(batch?.id ?? "", () => PROPOSAL);
    await pollBatches(world.gate.env, deps, dec(7, 3, 5));
    expect(await rows(world.d1.DB, "SELECT kind, cause, staff_id, status FROM lessons ORDER BY cause")).toEqual([
      { kind: "prompt_rule", cause: "staff_rule_denied", staff_id: "builder", status: "proposed" },
      { kind: "prompt_rule", cause: "token_rate", staff_id: "builder", status: "proposed" },
    ]);
    // ワークスペースを起こさず、1 件ずつの Messages API も呼ばない。バッチ処理の API だけを呼ぶ
    expect(Object.values(world.gate.staff).flatMap((s) => s.workspace)).toEqual([]);
    expect(Object.values(world.gate.workspaces).flatMap((w) => w.tickets)).toEqual([]);
    expect(world.gate.claude.requests).toEqual([]);
    expect(seen.every((s) => / http:\/\/localhost:5199\/anthropic\/v1\/messages\/batches/.test(s))).toBe(true);
    // 使った量は office の範囲で、バッチ処理の半額で残す
    const half = Math.ceil(costMicroUsd(OPUS, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }) / 2);
    expect(await rows(world.d1.REC_2026, "SELECT staff_id, node_id, scope, model, input_tokens, output_tokens, cost_micro_usd FROM usage")).toEqual([
      { staff_id: "reviewer", node_id: null, scope: "office", model: OPUS, input_tokens: 1000, output_tokens: 200, cost_micro_usd: half },
      { staff_id: "reviewer", node_id: null, scope: "office", model: OPUS, input_tokens: 1000, output_tokens: 200, cost_micro_usd: half },
    ]);
  });
});

describe("週のバッチ処理", () => {
  it("月曜 3 時の Cron で蒸留を、4 時の Cron で調べを始め、5 分ごとの定期ジョブが結果を入れる", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await addErrors(world, { at: dec(2, 10), fingerprint: "d".repeat(64), count: 2 });
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    // Cron は協定世界時なので、日本時間の月曜 3 時と 4 時は日曜の 18 時と 19 時
    expect([DISTILL_CRON, FINDINGS_CRON]).toEqual(["0 18 * * 0", "0 19 * * 0"]);
    expect(runWeekly(DISTILL_CRON, world.gate.env, ctx, { now: () => dec(7, 3) }, deps)).toBe(true);
    expect(runWeekly(FINDINGS_CRON, world.gate.env, ctx, { now: () => dec(7, 4) }, deps)).toBe(true);
    expect(runWeekly("*/5 * * * *", world.gate.env, ctx, { now: () => dec(7, 4) }, deps)).toBe(false);
    await Promise.all(waits);
    expect(world.gate.claude.batches.map((b) => b.requests.length)).toEqual([1, 1]);
    for (const b of world.gate.claude.batches) world.gate.claude.endBatch(b.id, () => PROPOSAL);
    waits.length = 0;
    runScheduled(world.gate.env, ctx, { now: () => dec(7, 4, 5) }, deps);
    await Promise.all(waits);
    expect(await rows(world.d1.DB, "SELECT kind, status FROM batches ORDER BY kind")).toEqual([
      { kind: "distill", status: "applied" },
      { kind: "findings", status: "applied" },
    ]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 1 }]);
    expect(await rows(world.d1.DB, "SELECT count FROM findings")).toEqual([{ count: 2 }]);
  });

  it("前の週は日本時間の月曜 0 時から次の月曜 0 時まで", () => {
    expect(previousWeek(dec(7, 3))).toEqual({ week: "2026-11-30", from: Date.UTC(2026, 10, 30, -9), to: dec(7, 0) });
    // 日曜の 23 時 59 分でも、その週でなく前の週を見る
    expect(previousWeek(dec(13, 23, 59)).week).toBe("2026-11-30");
    expect(previousWeek(dec(14, 0)).week).toBe("2026-12-07");
  });

  it("止めた記録が無い週は送らない", async () => {
    await addStop(world, { at: dec(7, 1), signal: "staff_rule_denied" });
    // 前の週の外 (11 月 29 日の日曜と、12 月 7 日の月曜) だけにある
    await addStop(world, { at: Date.UTC(2026, 10, 29, 23 - 9, 59), signal: "staff_rule_denied" });
    await runBatch(world, "distill", () => PROPOSAL, fakeTracker(), dec(7, 3));
    expect(world.gate.claude.batches).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
  });

  it("同じ週を 2 度始めても、同時に始めても、送るのは 1 度だけ", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    await Promise.all([startBatch(world.gate.env, "distill", deps, dec(7, 3)), startBatch(world.gate.env, "distill", deps, dec(7, 3))]);
    await startBatch(world.gate.env, "distill", deps, dec(7, 4));
    expect(world.gate.claude.batches).toHaveLength(1);
  });

  it("送れなかった時は始めた印を戻し、次に始め直せる", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    const down = { fetch: () => Promise.reject(new Error("届かない")), tracker: fakeTracker() };
    await startBatch(world.gate.env, "distill", down, dec(7, 3));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
    await runBatch(world, "distill", () => PROPOSAL, fakeTracker(), dec(7, 4));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 1 }]);
  });

  it("終わっていないバッチは待ち、同時に結果を読んでも案は 1 度だけ入る", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    await startBatch(world.gate.env, "distill", deps, dec(7, 3));
    await pollBatches(world.gate.env, deps, dec(7, 3, 5));
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "submitted" }]);
    world.gate.claude.endBatch(world.gate.claude.batches[0]?.id ?? "", () => PROPOSAL);
    await Promise.all([pollBatches(world.gate.env, deps, dec(7, 3, 10)), pollBatches(world.gate.env, deps, dec(7, 3, 10))]);
    await pollBatches(world.gate.env, deps, dec(7, 3, 15));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 1 }]);
    expect(await rows(world.d1.REC_2026, "SELECT count(*) AS n FROM usage")).toEqual([{ n: 1 }]);
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "applied" }]);
  });

  it("失敗した結果と形の違う答えは入れず、ほかの原因の案は入れる", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await addStop(world, { at: dec(2, 10), signal: "token_rate" });
    await addStop(world, { at: dec(3, 10), signal: "task_overrun" });
    await runBatch(
      world,
      "distill",
      (id) => {
        if (id === "c0") return "errored";
        // 説明文の案に社員が無い、知らない種類の案は入れない
        if (id === "c1") return answerJson({ proposals: [{ kind: "prompt_rule", staffId: null, proposal: "誰に" }, { kind: "budget", staffId: null, proposal: "x" }] });
        return { content: [{ type: "text", text: "```json\n" + JSON.stringify({ proposals: [{ kind: "rule_tool", staffId: null, proposal: "最長を測り直す" }] }) + "\n```" }] };
      },
      fakeTracker(),
      dec(7, 3),
    );
    expect(await rows(world.d1.DB, "SELECT kind, cause FROM lessons")).toEqual([{ kind: "rule_tool", cause: "token_rate" }]);
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "applied" }]);
  });

  it("結果を入れる途中で落ちたら何も残さず、次に読み直して入れる", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    const deps = { fetch: world.gate.fetch, tracker: fakeTracker() };
    await startBatch(world.gate.env, "distill", deps, dec(7, 3));
    world.gate.claude.endBatch(world.gate.claude.batches[0]?.id ?? "", () => PROPOSAL);
    onNextBatch(world, () => Promise.reject(new Error("D1 が落ちた")));
    await pollBatches(world.gate.env, deps, dec(7, 3, 5));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 0 }]);
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "submitted" }]);
    await pollBatches(world.gate.env, deps, dec(7, 3, 10));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 1 }]);
  });

  it("Claude が返したバッチの ID の形が違えば使わない", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    const forged = { fetch: () => Promise.resolve(Response.json({ id: "../../v1/files", type: "message_batch", processing_status: "in_progress" })), tracker: fakeTracker() };
    await startBatch(world.gate.env, "distill", forged, dec(7, 3));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
  });
});
