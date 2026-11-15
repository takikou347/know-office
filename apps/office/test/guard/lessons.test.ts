// 蒸留の案を入れる事と、入れた対策の効き目を見る事。案は週のバッチで入り、基準の直しはパスキーで確かめたオーナーだけが入れる (サービスと拡張の 3.6、ルートの一覧の 1.5)
import { DEFAULT_THRESHOLDS, newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lessons } from "../../src/gate/db/main.ts";
import { advance, api, MINUTE, rows, type WorkWorld } from "../helpers/work.ts";
import { addStop, answerJson, DAY, dec, fakeTracker, onNextBatch, runBatch, useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

const LessonRow = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    kind: z.enum(["prompt_rule", "threshold", "rule_tool"]),
    cause: z.string(),
    proposal: z.string(),
    staffId: z.string().nullable(),
    stopIds: z.array(z.string()),
    status: z.string(),
  })
  .strict();

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 案を 1 件、直に置く
 * @param w テストの物
 * @param input 種類、原因、案、社員、状態
 * @param input.kind 種類
 * @param input.cause 原因
 * @param input.staffId 説明文に足す社員
 * @param input.status 状態
 * @param input.appliedAt 入れた時刻
 * @returns 案の ID
 */
async function lesson(
  w: WorkWorld,
  input: { kind: "prompt_rule" | "threshold" | "rule_tool"; cause?: string; staffId?: string | null; status?: string; appliedAt?: number | null },
): Promise<string> {
  const id = newId(w.clock);
  await drizzle(w.d1.DB)
    .insert(lessons)
    .values({
      id,
      createdAt: w.clock.now(),
      kind: input.kind,
      cause: input.cause ?? "staff_rule_denied",
      proposal: "push の前にブランチを確かめる",
      staffId: input.staffId ?? null,
      stopIds: [],
      status: input.status ?? "proposed",
      appliedAt: input.appliedAt ?? null,
    });
  return id;
}

/**
 * 今の基準を読む
 * @param w テストの物
 * @returns 版と値
 */
async function thresholds(w: WorkWorld): Promise<{ version: number; values: Record<string, number> }> {
  return z.object({ version: z.number(), values: z.record(z.string(), z.number()) }).parse(await api(w, "GET", "/api/v1/guard/thresholds"));
}

describe("蒸留", () => {
  it("案を入れる", async () => {
    const first = await addStop(world, { at: dec(1, 10), signal: "staff_rule_denied", verdict: "false" });
    const second = await addStop(world, { at: dec(2, 11), signal: "staff_rule_denied", kind: "near" });
    await runBatch(
      world,
      "distill",
      () => answerJson({ proposals: [{ kind: "threshold", staffId: null, proposal: "staffRuleDenied を 3 にする" }] }),
      fakeTracker(),
      dec(7, 3),
    );
    await advance(world, dec(7, 9));
    const [proposed] = z.array(LessonRow).parse(await api(world, "GET", "/api/v1/guard/lessons"));
    expect(proposed).toMatchObject({ kind: "threshold", cause: "staff_rule_denied", proposal: "staffRuleDenied を 3 にする", status: "proposed" });
    expect(proposed?.stopIds.toSorted()).toEqual([first, second].toSorted());
    const lessonId = proposed?.id ?? "";

    // オーナーが承認しても、基準の案は承認の記録だけで、基準は変わらない
    expect(await api(world, "POST", `/api/v1/guard/lessons/${lessonId}/decision`, { decision: "approve", reason: "試す" })).toMatchObject({ id: lessonId, status: "approved" });
    expect(await thresholds(world)).toEqual({ version: 0, values: DEFAULT_THRESHOLDS });

    // パスキーで確かめるまでは基準を変えられない
    const denied = await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { staffRuleDenied: 3 }, reason: "蒸留の案", lessonId }, 401);
    expect(denied).toMatchObject({ code: "step_up_required" });
    expect(await thresholds(world)).toEqual({ version: 0, values: DEFAULT_THRESHOLDS });

    await stepUp(world);
    expect(await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { staffRuleDenied: 3 }, reason: "蒸留の案", lessonId })).toEqual({
      version: 1,
      values: { ...DEFAULT_THRESHOLDS, staffRuleDenied: 3 },
    });
    expect(await thresholds(world)).toMatchObject({ version: 1, values: { staffRuleDenied: 3 } });
    expect(await rows(world.d1.DB, "SELECT status, applied_at FROM lessons WHERE id = ?", lessonId)).toEqual([{ status: "applied", applied_at: world.clock.now() }]);
    expect(world.gate.audits.filter((a) => a.action === "guard.thresholds")).toEqual([
      expect.objectContaining({ target: "guard.thresholds", detail: { before: { staffRuleDenied: 2 }, after: { staffRuleDenied: 3 }, version: 1, reason: "蒸留の案", lessonId } }),
    ]);
    // 社員のツールに基準を変える物は無い
    expect(world.gate.audits.filter((a) => a.action === "lesson.decide")).toEqual([expect.objectContaining({ actor: "owner", target: lessonId })]);
  });

  it("効き目を見る", async () => {
    const applied = dec(10, 12);
    // 入れる前の 7 日に同じ原因で 4 回、入れた後の 7 日に 1 回止めた。ほかの原因で 2 回止めた
    await addStop(world, { at: applied - 6 * DAY, signal: "staff_rule_denied", verdict: "false" });
    await addStop(world, { at: applied - 5 * DAY, signal: "staff_rule_denied", verdict: "false" });
    await addStop(world, { at: applied - 4 * DAY, signal: "staff_rule_denied", verdict: "correct" });
    await addStop(world, { at: applied - 3 * DAY, signal: "staff_rule_denied" });
    await addStop(world, { at: applied + 2 * DAY, signal: "staff_rule_denied", verdict: "correct" });
    await addStop(world, { at: applied - 2 * DAY, signal: "token_rate", verdict: "correct" });
    await addStop(world, { at: applied + DAY, signal: "token_rate" });
    // 近かった記録と、7 日より前の止めた記録は対策の比べに入れない
    await addStop(world, { at: applied - DAY, signal: "staff_rule_denied", kind: "near" });
    await addStop(world, { at: applied - 8 * DAY, signal: "staff_rule_denied" });
    const lessonId = await lesson(world, { kind: "threshold", status: "applied", appliedAt: applied });
    await lesson(world, { kind: "rule_tool", status: "proposed" });
    await advance(world, dec(20, 9));

    const effect = await api(world, "GET", "/api/v1/guard/effect");
    expect(effect).toEqual({
      stops: 8,
      // 判定した 5 件のうち 2 件を誤って止めた
      falseRatio: 0.4,
      topCauses: [
        { signal: "staff_rule_denied", count: 6 },
        { signal: "token_rate", count: 2 },
      ],
      measures: [{ lessonId, before: 4, after: 1 }],
    });
    // 期間で絞る。日本時間の日で、to の日を含む
    expect(await api(world, "GET", `/api/v1/guard/effect?from=2026-12-11&to=2026-12-12`)).toMatchObject({ stops: 2, topCauses: [{ signal: "staff_rule_denied", count: 1 }, { signal: "token_rate", count: 1 }] });
  });
});

describe("改善案の決め方", () => {
  it("説明文の案を承認すると、その社員の説明文に新しい版を足す", async () => {
    const id = await lesson(world, { kind: "prompt_rule", staffId: "builder" });
    const before = await rows(world.d1.DB, "SELECT prompt_version AS v FROM staff WHERE id = 'builder'");
    const v = Number(before[0]?.["v"]);
    expect(await api(world, "POST", `/api/v1/guard/lessons/${id}/decision`, { decision: "approve", reason: "入れる" })).toMatchObject({ status: "applied" });
    const [latest] = await rows(world.d1.DB, "SELECT version, body, by FROM staff_prompts WHERE staff_id = 'builder' ORDER BY version DESC LIMIT 1");
    expect(latest).toMatchObject({ version: v + 1, by: "owner" });
    expect(String(latest?.["body"])).toContain("push の前にブランチを確かめる");
    expect(await rows(world.d1.DB, "SELECT prompt_version AS v FROM staff WHERE id = 'builder'")).toEqual([{ v: v + 1 }]);
  });

  it("決める直前に説明文が変わったら 409 で、案も説明文も変えない", async () => {
    const id = await lesson(world, { kind: "prompt_rule", staffId: "builder" });
    // 決める batch の直前に、オーナーが説明文を直した事にする
    onNextBatch(world, async (run) => {
      await world.d1.DB.prepare("UPDATE staff SET prompt_version = prompt_version + 1 WHERE id = 'builder'").run();
      return run();
    });
    const prompts = await rows(world.d1.DB, "SELECT count(*) AS n FROM staff_prompts");
    await api(world, "POST", `/api/v1/guard/lessons/${id}/decision`, { decision: "approve", reason: "入れる" }, 409);
    expect(await rows(world.d1.DB, "SELECT status FROM lessons WHERE id = ?", id)).toEqual([{ status: "proposed" }]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM staff_prompts")).toEqual(prompts);
  });

  it("ルールの案を承認すると開発担当にタスクを足し、差し戻した案は何も足さない", async () => {
    const rule = await lesson(world, { kind: "rule_tool" });
    const rejected = await lesson(world, { kind: "rule_tool" });
    expect(await api(world, "POST", `/api/v1/guard/lessons/${rule}/decision`, { decision: "approve", reason: "直す" })).toMatchObject({ status: "approved" });
    expect(await api(world, "POST", `/api/v1/guard/lessons/${rejected}/decision`, { decision: "reject", reason: "要らない" })).toMatchObject({ status: "rejected" });
    expect(await rows(world.d1.DB, "SELECT kind, task_kind, assignee, status, source FROM nodes WHERE kind = 'task'")).toEqual([
      { kind: "task", task_kind: "fix", assignee: "builder", status: "todo", source: `lesson:${rule}` },
    ]);
  });

  it("同時に 2 つ決めると片方だけが通り、もう片方は 409", async () => {
    const id = await lesson(world, { kind: "rule_tool" });
    const results = await Promise.all([
      world.gate.request(`/api/v1/guard/lessons/${id}/decision`, { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve", reason: "a" }) }),
      world.gate.request(`/api/v1/guard/lessons/${id}/decision`, { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject", reason: "b" }) }),
    ]);
    expect(results.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM nodes WHERE kind = 'task'")).toEqual([{ n: results[0]?.status === 200 ? 1 : 0 }]);
    // 決めた後にもう一度決めても 409
    await api(world, "POST", `/api/v1/guard/lessons/${id}/decision`, { decision: "approve", reason: "c" }, 409);
  });

  it("無い案は 404、形の違う ID とカーソルは 422、知らないクエリは 400", async () => {
    expect(await api(world, "POST", `/api/v1/guard/lessons/${newId(world.clock)}/decision`, { decision: "approve", reason: "無い" }, 404)).toMatchObject({ code: "not_found" });
    expect(await api(world, "POST", "/api/v1/guard/lessons/not-a-uuid/decision", { decision: "approve", reason: "形" }, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "GET", "/api/v1/guard/lessons?cursor=x'--", undefined, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "GET", "/api/v1/guard/lessons?status=proposed", undefined, 400)).toMatchObject({ code: "malformed_request" });
  });

  it("案の一覧は新しい順で、limit とカーソルで続きを読む", async () => {
    const a = await lesson(world, { kind: "rule_tool" });
    world.clock.advance(1);
    const b = await lesson(world, { kind: "threshold" });
    const res = await world.gate.request("/api/v1/guard/lessons?limit=1", { headers: world.headers });
    const page = z.object({ data: z.array(LessonRow), meta: z.object({ next: z.string().nullable() }).loose() }).parse(await res.json());
    expect(page.data.map((l) => l.id)).toEqual([b]);
    expect(page.meta.next).toBe(b);
    expect(z.array(LessonRow).parse(await api(world, "GET", `/api/v1/guard/lessons?limit=1&cursor=${b}`)).map((l) => l.id)).toEqual([a]);
  });
});

describe("基準を変える", () => {
  it("古い版から直すと 409 で、同時に 2 つ直すと片方だけが通る", async () => {
    await stepUp(world);
    const results = await Promise.all(
      [4, 5].map((n) =>
        world.gate.request("/api/v1/guard/thresholds", {
          method: "PUT",
          headers: { ...world.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ version: 0, values: { repeatedFailures: n }, reason: "同時" }),
        }),
      ),
    );
    expect(results.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await rows(world.d1.DB, "SELECT version FROM settings WHERE key = 'guard.thresholds'")).toEqual([{ version: 1 }]);
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 6 }, reason: "古い" }, 409);
  });

  it("承認していない案と、基準でない案を入れた事にはできず、基準も変えない", async () => {
    await stepUp(world);
    const proposed = await lesson(world, { kind: "threshold" });
    const rule = await lesson(world, { kind: "rule_tool", status: "approved" });
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 4 }, reason: "まだ", lessonId: proposed }, 409);
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 4 }, reason: "違う", lessonId: rule }, 409);
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 4 }, reason: "無い", lessonId: newId(world.clock) }, 404);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM settings WHERE key = 'guard.thresholds'")).toEqual([{ n: 0 }]);
    expect(world.gate.audits.filter((a) => a.action === "guard.thresholds")).toEqual([]);
  });

  it("知らない項目と、基準の形に合わない値は 422", async () => {
    await stepUp(world);
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { budget: 1 }, reason: "無い項目" }, 422);
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 0 }, reason: "0 回" }, 422);
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 1.5 }, reason: "小数" }, 422);
    // 上限ちょうどの 1 回は通る
    expect(await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 1 }, reason: "1 回" })).toMatchObject({ version: 1 });
  });

  it("効き目の期間の from が to より後なら 422", async () => {
    expect(await api(world, "GET", "/api/v1/guard/effect?from=2026-12-02&to=2026-12-01", undefined, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "GET", "/api/v1/guard/effect?from=12/01", undefined, 422)).toMatchObject({ code: "validation_failed" });
    // 同じ日は 1 日の期間として通る
    expect(await api(world, "GET", "/api/v1/guard/effect?from=2026-12-01&to=2026-12-01")).toMatchObject({ stops: 0 });
  });
});
