// 週のバッチ処理と急ぐ故障の調べの切れ目。鍵の誤り、切れた答え、結果の分からない送り、終わらないバッチを、通知して止める (サービスと拡張の 3.6、3.7)
import type { Fetcher } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { pollBatches, startBatch } from "../../src/gate/jobs/weekly.ts";
import { rows } from "../helpers/work.ts";
import { addStop, answerJson, dec, fakeTracker, runBatch, useWeekly } from "../helpers/weekly.ts";
import { ANTHROPIC_KEY } from "../helpers/gate.ts";

const world = useWeekly();

const PROPOSAL = answerJson({ proposals: [{ kind: "prompt_rule", staffId: "builder", proposal: "main に push しない" }] }, { input_tokens: 1000, output_tokens: 200 });

const HOUR = 60 * 60_000;

/**
 * 代わりの Claude API が通す鍵を替える。空にすると、ゲートウェイの鍵を Anthropic の画面で消した時にあたる
 * @param keys 通す鍵
 */
function acceptKeys(keys: string[]): void {
  world.gate.claude.accepted.clear();
  for (const key of keys) world.gate.claude.accepted.add(key);
}

/**
 * 外へ頼む口。fetch は初期値でテストのゲートウェイの物
 * @param fetch 外への fetch
 * @returns 外へ頼む口
 */
function depsOf(fetch: Fetcher = world.gate.fetch) {
  return { fetch, tracker: fakeTracker() };
}

/**
 * 通知の種類ごとの件数を読む
 * @param kind 通知の種類
 * @returns 読んでいない件数
 */
async function openNotices(kind: string): Promise<unknown[]> {
  return rows(world.d1.DB, `SELECT title FROM notices WHERE kind = '${kind}' AND read_at IS NULL`);
}

/**
 * 決まったステータスを返す fetch を作る
 * @param code ステータス
 * @returns fetch
 */
function status(code: number): Fetcher {
  return () => Promise.resolve(Response.json({ type: "error", error: { type: "x" } }, { status: code }));
}

describe("落ちても続きから", () => {
  it("鍵が断られる", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    acceptKeys([]);
    expect(await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3))).toBeNull();
    expect(await openNotices("sdk_auth_failed")).toHaveLength(1);
    // 断られた送りは作られていないので、印を戻す
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
    // 鍵を入れ直しても、オーナーが通知を読むまでは送らない
    acceptKeys([ANTHROPIC_KEY]);
    const calls = world.gate.claude.keys.length;
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3, 5));
    await pollBatches(world.gate.env, depsOf(), dec(7, 3, 5));
    expect(world.gate.claude.keys).toHaveLength(calls);
    await world.d1.DB.prepare("UPDATE notices SET read_at = ? WHERE kind = 'sdk_auth_failed'").bind(dec(7, 3, 6)).run();
    await runBatch(world, "distill", () => PROPOSAL, fakeTracker(), dec(7, 3, 10));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 1 }]);
  });

  it("答えが切れる", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await addStop(world, { at: dec(1, 11), signal: "staff_tokens_spike" });
    // 出力の上限で切れた答えは、閉じた JSON に見えても入れない。断りの答えも入れない
    const cut = { ...PROPOSAL, stop_reason: "max_tokens" };
    const refused = { content: [{ type: "text", text: "" }], stop_reason: "refusal", usage: { input_tokens: 1000, output_tokens: 5 } };
    let i = 0;
    await runBatch(world, "distill", () => (i++ === 0 ? cut : refused), fakeTracker(), dec(7, 3));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM lessons")).toEqual([{ n: 0 }]);
    // 切れた答えも断りも費用は出るので、使った量は残す
    expect(await rows(world.d1.REC_2026, "SELECT count(*) AS n FROM usage")).toEqual([{ n: 2 }]);
    const codes = await rows(world.d1.REC_2026, "SELECT code FROM error_events WHERE code LIKE 'distill_answer_%' ORDER BY code");
    expect(codes).toEqual([{ code: "distill_answer_max_tokens" }, { code: "distill_answer_refusal" }]);
  });

  it("送った結果が分からない", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    // 本物に届いて作られたが、返事が時間切れで返らなかった時
    const lost: Fetcher = async (url, init) => {
      await world.gate.fetch(url, init);
      throw new DOMException("時間切れ", "TimeoutError");
    };
    expect(await startBatch(world.gate.env, "distill", depsOf(lost), dec(7, 3))).toBeNull();
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "unknown" }]);
    // 行を残すので、同じ週に 2 度は送らない
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 4));
    expect(world.gate.claude.batches).toHaveLength(1);
  });

  it("終わらないバッチ", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3));
    // Anthropic の側で見つからなくなった時は、続けて 3 回で失敗にする
    world.gate.claude.batches.length = 0;
    for (const m of [5, 10]) await pollBatches(world.gate.env, depsOf(), dec(7, 3, m));
    expect(await rows(world.d1.DB, "SELECT status, failures FROM batches")).toEqual([{ status: "submitted", failures: 2 }]);
    await pollBatches(world.gate.env, depsOf(), dec(7, 3, 15));
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "failed" }]);
    expect(await openNotices("batch_failed")).toHaveLength(1);
  });
});

describe("週のバッチ処理の切れ目", () => {
  it("送る要求は出力の上限と考える深さを持つ", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3));
    expect(world.gate.claude.batches[0]?.requests[0]?.params).toMatchObject({ max_tokens: 8000, output_config: { effort: "low" } });
  });

  it("終わりを見る時に鍵が断られたら通知し、読むまで次の終わりを見ない", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3));
    acceptKeys([]);
    await pollBatches(world.gate.env, depsOf(), dec(7, 3, 5));
    expect(await openNotices("sdk_auth_failed")).toHaveLength(1);
    const calls = world.gate.claude.keys.length;
    await pollBatches(world.gate.env, depsOf(), dec(7, 3, 10));
    expect(world.gate.claude.keys).toHaveLength(calls);
    expect(await rows(world.d1.DB, "SELECT status, failures FROM batches")).toEqual([{ status: "submitted", failures: 0 }]);
  });

  it("送りが断られた時は印を戻して次に送り直し、届いたか分からない 5xx は行を残す", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await startBatch(world.gate.env, "distill", depsOf(status(529)), dec(7, 3));
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM batches")).toEqual([{ n: 0 }]);
    await startBatch(world.gate.env, "distill", depsOf(status(502)), dec(7, 3, 1));
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "unknown" }]);
  });

  it("送る前に落ちて残った印は、時間がたっても送り直さない", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await world.d1.DB.prepare("INSERT INTO batches (id, kind, week, batch_id, status, detail, created_at, ended_at) VALUES ('b1', 'distill', '2026-11-30', NULL, 'pending', NULL, ?, NULL)").bind(dec(7, 3)).run();
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 4));
    expect(world.gate.claude.batches).toHaveLength(0);
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "unknown" }]);
  });

  it("期限を過ぎても終わらないバッチは失敗にして通知し、期限ちょうどまでは待つ", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3));
    // Anthropic のバッチは 24 時間で切れるので、1 時間の余りを見て 25 時間を期限にする
    await pollBatches(world.gate.env, depsOf(), dec(7, 3) + 25 * HOUR);
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "submitted" }]);
    await pollBatches(world.gate.env, depsOf(), dec(7, 3) + 25 * HOUR + 1);
    expect(await rows(world.d1.DB, "SELECT status FROM batches")).toEqual([{ status: "failed" }]);
    expect(await openNotices("batch_failed")).toHaveLength(1);
  });

  it("見つからなかった回数は、次に見えたら数え直す", async () => {
    await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied" });
    await startBatch(world.gate.env, "distill", depsOf(), dec(7, 3));
    const kept = [...world.gate.claude.batches];
    world.gate.claude.batches.length = 0;
    for (const m of [5, 10]) await pollBatches(world.gate.env, depsOf(), dec(7, 3, m));
    world.gate.claude.batches.push(...kept);
    await pollBatches(world.gate.env, depsOf(), dec(7, 3, 15));
    expect(await rows(world.d1.DB, "SELECT status, failures FROM batches")).toEqual([{ status: "submitted", failures: 0 }]);
  });
});
