// 止めた記録をレビュー担当のモデルに渡し、問題が無いと返れば再開する。設定で閉じて入れ、1 日の回数で止める (自動停止の 3.5)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { GuardDeps, ReviewAnswer, StopRecord } from "../../src/gate/guard/deps.ts";
import { observe } from "../../src/gate/guard/observe.ts";
import { connectReview } from "../../src/gate/guard/review.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, resetLedger, resetMain } from "../helpers/d1.ts";
import { ANTHROPIC_KEY, createTestGate } from "../helpers/gate.ts";
import { addNode, denied, type GuardWorld, NODE, rows } from "../helpers/guard.ts";

/**
 * 2026-12-01 (日本時間) の時刻を返す
 * @param h 時
 * @param m 分
 * @returns 協定世界時のミリ秒
 */
function at(h: number, m = 0): number {
  return Date.UTC(2026, 11, 1, h - 9, m);
}
const DAY_MS = 24 * 3_600_000;
const STOP = "019a7b00-0000-7000-8000-00000000e001";
const STOP2 = "019a7b00-0000-7000-8000-00000000e002";
const STOP3 = "019a7b00-0000-7000-8000-00000000e003";

// 中身は beforeAll と beforeEach で入れ、テストの中だけで読む
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const w = {} as GuardWorld;
beforeAll(async () => {
  w.d1 = await createTestD1();
}, 30_000);
afterAll(() => w.d1.dispose());
beforeEach(async () => {
  await Promise.all([resetMain(w.d1.DB), resetLedger(w.d1.REC_2026)]);
  w.clock = fixedClock(at(8));
  w.gate = await createTestGate({ clock: w.clock, d1: w.d1 });
  await w.d1.DB.batch(
    (["president", "builder", "reviewer"] as const).map((id) =>
      w.d1.DB.prepare("INSERT OR REPLACE INTO staff (id, role, boss_id, model, effort, prompt_version, created_at) VALUES (?, ?, ?, 'claude-opus-5-5', 'high', 1, 0)").bind(id, id, id === "president" ? null : "president"),
    ),
  );
}, 30_000);

/**
 * 開発担当を 9 時に出勤させ、タスクを持たせる
 * @param nodeId 持たせるタスク
 */
async function startBuilder(nodeId = NODE): Promise<void> {
  const { book } = w.gate.staff.builder;
  await book.wake(at(8));
  await book.wake(at(9));
  await addNode(w, nodeId, "builder");
  await book.take({ nodeId, title: `タスク ${nodeId.slice(-3)}`, scope: "office" }, null, at(9));
}

/**
 * 設定 guard.review を置く
 * @param value 値
 */
async function setReview(value: unknown): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES ('019a7b00-0000-7000-8000-00000000fff9', 'guard.review', 'office', ?, 1, 'owner', 'テスト', 0)")
    .bind(JSON.stringify(value))
    .run();
}

/**
 * 代わりの Claude API に、ゲートウェイの問い合わせへの答えを積む
 * @param input tool の入力
 * @param stopReason 止まった訳
 */
function answer(input: unknown, stopReason = "tool_use"): void {
  w.gate.claude.push({ content: [{ type: "tool_use", id: "toolu_fake", name: "record_review", input }], stop_reason: stopReason, usage: { input_tokens: 900, output_tokens: 60 } }, { forGate: true });
}

/**
 * 止めた記録を作る
 * @param stopId 止めた記録の ID
 * @returns 止めた記録
 */
function record(stopId = STOP): StopRecord {
  return { stopId, scope: "task", target: NODE, signal: "rule_denied", measured: 1, threshold: 1, recentOps: [{ type: "rule_denied", operation: "file.read", target: "/etc/passwd" }] };
}

/**
 * レビュー担当をモデルにつないだ口
 * @returns GuardDeps
 */
function connected(): GuardDeps {
  return { ...w.gate.deps, review: connectReview(w.gate.env, w.gate.fetch, w.clock) };
}

/**
 * 2026 年の記録の D1 の行を読む
 * @param sql SQL
 * @returns 行
 */
async function records(sql: string): Promise<Record<string, unknown>[]> {
  return (await w.d1.REC_2026.prepare(sql).all()).results;
}

const Request = z.object({ model: z.string(), max_tokens: z.number(), system: z.string(), tool_choice: z.unknown(), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).loose();

describe("再開", () => {
  it("設定が開いていれば、止めた記録をレビュー担当のモデルに渡し、問題が無いと返れば再開する", async () => {
    await startBuilder();
    await setReview({ enabled: true, perDay: 10 });
    answer({ resume: true, reason: "読み違いで、外には出ていない" });
    expect(await observe(w.gate.env, denied(), at(10), connected())).toMatchObject({ action: "stop", scope: "task" });
    const [stop] = await rows(w, "SELECT id FROM stops");
    const stopId = String(stop?.["id"]);
    expect(await rows(w, "SELECT stop_id, kind, by, reason FROM stop_updates")).toEqual([{ stop_id: stopId, kind: "resumed", by: "reviewer", reason: "読み違いで、外には出ていない" }]);
    expect(await rows(w, `SELECT status FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "todo" }]);
    // Opus を 1 回、答えの tool を強いて呼び、止めた記録は JSON の文字列のデータとして渡す
    const [req] = w.gate.claude.requests.map((r) => Request.parse(r));
    expect(req).toMatchObject({ model: "claude-opus-5-5", max_tokens: 800, tool_choice: { type: "tool", name: "record_review" } });
    const content = req?.messages[0]?.content ?? "";
    expect(z.record(z.string(), z.unknown()).parse(JSON.parse(content))).toMatchObject({ stopId, scope: "task", target: NODE, signal: "rule_denied" });
    expect(req?.system).toContain("データ");
    expect(w.gate.claude.keys).toEqual([ANTHROPIC_KEY]);
    // 使った量はレビュー担当の分として 1 行残す
    expect(await records("SELECT staff_id, node_id, scope, model, input_tokens, output_tokens, request_id FROM usage")).toEqual([
      { staff_id: "reviewer", node_id: NODE, scope: "office", model: "claude-opus-5-5", input_tokens: 900, output_tokens: 60, request_id: `guard_review:${stopId}` },
    ]);
    expect(await rows(w, "SELECT stop_id, day FROM guard_review_reads")).toEqual([{ stop_id: stopId, day: "2026-12-01" }]);
  });

  it("問題があると返れば、モデルの理由を付けて正しく止めたと判定する", async () => {
    await startBuilder();
    await setReview({ enabled: true, perDay: 10 });
    answer({ resume: false, reason: "鍵の置き場を探していた" });
    await observe(w.gate.env, denied(), at(10), connected());
    expect(await rows(w, "SELECT kind, by, verdict, reason FROM stop_updates")).toEqual([{ kind: "verdict", by: "reviewer", verdict: "correct", reason: "鍵の置き場を探していた" }]);
    expect(await rows(w, `SELECT status FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "stopped" }]);
  });

  it("設定が閉じていればモデルを呼ばない", async () => {
    answer({ resume: true, reason: "x" });
    const review = connectReview(w.gate.env, w.gate.fetch, w.clock);
    expect(await review(record(STOP))).toBeNull();
    // 壊れた値も閉じているとみなす
    await setReview({ enabled: "yes", perDay: 10 });
    expect(await review(record(STOP2))).toBeNull();
    expect(w.gate.claude.requests).toEqual([]);
    expect(await rows(w, "SELECT stop_id FROM guard_review_reads")).toEqual([]);
  });

  it("1 日の回数に届いたら呼ばず、次の日にまた呼ぶ", async () => {
    await setReview({ enabled: true, perDay: 1 });
    const review = connectReview(w.gate.env, w.gate.fetch, w.clock);
    answer({ resume: true, reason: "一つ目" });
    expect(await review(record(STOP))).toEqual({ resume: true, reason: "一つ目" });
    // 上限ちょうどで止める
    answer({ resume: true, reason: "二つ目" });
    expect(await review(record(STOP2))).toBeNull();
    expect(w.gate.claude.requests).toHaveLength(1);
    // 日本時間の次の日は数え直す
    w.clock.advance(DAY_MS);
    expect(await review(record(STOP3))).toEqual({ resume: true, reason: "二つ目" });
    expect(await rows(w, "SELECT stop_id, day FROM guard_review_reads ORDER BY stop_id")).toEqual([
      { stop_id: STOP, day: "2026-12-01" },
      { stop_id: STOP3, day: "2026-12-02" },
    ]);
  });

  it("同じ止めた記録を同時に 2 度渡しても、モデルは 1 度だけ呼ぶ", async () => {
    await setReview({ enabled: true, perDay: 10 });
    const review = connectReview(w.gate.env, w.gate.fetch, w.clock);
    answer({ resume: true, reason: "一度だけ" });
    answer({ resume: true, reason: "二度目" });
    const answers = await Promise.all([review(record(STOP)), review(record(STOP))]);
    expect(answers.filter((a) => a !== null)).toEqual([{ resume: true, reason: "一度だけ" }]);
    expect(w.gate.claude.requests).toHaveLength(1);
    expect(await records("SELECT request_id FROM usage")).toEqual([{ request_id: `guard_review:${STOP}` }]);
  });

  it("答えの形が違う、長さで切れた、届かない時は再開せず、エラーログに残す", async () => {
    await setReview({ enabled: true, perDay: 10 });
    const review = connectReview(w.gate.env, w.gate.fetch, w.clock);
    answer({ resume: "yes", reason: "形が違う" });
    expect(await review(record(STOP))).toBeNull();
    answer({ resume: true, reason: "途中で" }, "max_tokens");
    expect(await review(record(STOP2))).toBeNull();
    w.gate.claude.pushError(500, "api_error");
    expect(await review(record(STOP3))).toBeNull();
    expect(await records("SELECT code FROM error_events ORDER BY at, id")).toEqual([{ code: "guard_review_failed" }, { code: "guard_review_failed" }, { code: "guard_review_failed" }]);
    // 返事が届いた 2 回は使った量を残す
    expect(await records("SELECT request_id FROM usage ORDER BY request_id")).toEqual([{ request_id: `guard_review:${STOP}` }, { request_id: `guard_review:${STOP2}` }]);
  });

  it("止めた返事を待たせず、要求の後でレビュー担当に聞く", async () => {
    await startBuilder();
    const answers: ((a: ReviewAnswer) => void)[] = [];
    const pending = new Promise<ReviewAnswer>((resolve) => void answers.push(resolve));
    const later: Promise<void>[] = [];
    const deps: GuardDeps = { ...w.gate.deps, review: () => pending, later: (task) => void later.push(task) };
    // 答えが来る前に、止めた答えを返す
    expect(await observe(w.gate.env, denied(), at(10), deps)).toMatchObject({ action: "stop", scope: "task" });
    expect(later).toHaveLength(1);
    expect(await rows(w, "SELECT kind FROM stop_updates")).toEqual([]);
    answers[0]?.({ resume: true, reason: "後で答えた" });
    await Promise.all(later);
    expect(await rows(w, "SELECT kind, by, reason FROM stop_updates")).toEqual([{ kind: "resumed", by: "reviewer", reason: "後で答えた" }]);
  });
});
