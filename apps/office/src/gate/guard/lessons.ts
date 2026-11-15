// 蒸留の案を決める、基準を変える、自動停止の効き目を出す。案は社員のツールからは入れられず、オーナーの承認か、パスキーで確かめた基準の変更でだけ入る (サービスと拡張の 3.6、ルートの一覧の 1.5)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type GuardEffect, jstDayStart, Lesson, LessonKind, LessonStatus, newId, StaffId, Thresholds, type UpdateThresholdsInput } from "@know-office/core";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { lessons, nodes, settings, staff, staffPrompts } from "../db/main.ts";
import { insertWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import { type Actor, intakeProject, newNodeRow, type NodeRow, recordCreated } from "../work/nodes.ts";
import { notifyStaff } from "../work/loop.ts";
import { loadThresholds } from "./thresholds.ts";

const DAY = 24 * 60 * 60_000;

/** 入れた対策の前後を比べる間 */
const MEASURE_MS = 7 * DAY;

/** 多い原因に出す数 */
const TOP_CAUSES = 5;

/** lessons の行 */
type LessonRow = typeof lessons.$inferSelect;

const StopIds = z.array(z.string());

/**
 * lessons の行を返す形に直す
 * @param row lessons の行
 * @returns 蒸留の案
 */
export function toLesson(row: LessonRow): Lesson {
  const stopIds = StopIds.safeParse(row.stopIds);
  const staffId = StaffId.safeParse(row.staffId);
  return Lesson.parse({
    id: row.id,
    createdAt: new Date(row.createdAt).toISOString(),
    kind: LessonKind.parse(row.kind),
    cause: row.cause,
    proposal: row.proposal,
    staffId: staffId.success ? staffId.data : null,
    stopIds: stopIds.success ? stopIds.data : [],
    status: LessonStatus.parse(row.status),
  });
}

/**
 * 案を新しい順に読む
 * @param db 今の状態の D1
 * @param cursor 前のページの最後の ID
 * @param limit 件数
 * @returns 案と次のカーソル
 */
export async function listLessons(db: D1Database, cursor: string | undefined, limit: number): Promise<{ items: Lesson[]; next: string | null }> {
  const rows = await drizzle(db)
    .select()
    .from(lessons)
    .where(cursor ? lt(lessons.id, cursor) : undefined)
    .orderBy(desc(lessons.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(toLesson), next: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

/**
 * 案を承認するか差し戻す。説明文の案は社員の説明文に新しい版を足して applied に、ルールの案は開発担当にタスクを足して approved に、基準の案は承認の記録だけを残す
 * 案がまだ決まっていない事と、読んだ説明文の版のままである事を、書く 1 回のバッチの条件に入れる
 * @param env バインディング
 * @param lessonId 案の ID
 * @param decision approve か reject
 * @param actor 決めた人と時刻
 * @returns 決めた後の案
 * @throws not_found 案が無い時
 * @throws conflict もう決めた時、決める間に説明文が変わった時
 */
export async function decideLesson(env: Bindings, lessonId: string, decision: "approve" | "reject", actor: Actor): Promise<{ lesson: Lesson; task: NodeRow | null }> {
  const orm = drizzle(env.DB);
  const [row] = await orm.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!row) throw new AppError("not_found", "案が無い");
  if (row.status !== "proposed") throw new AppError("conflict", "もう決めた");
  const now = actor.now;
  const proposed = sql`EXISTS (SELECT 1 FROM ${lessons} WHERE ${lessons.id} = ${lessonId} AND ${lessons.status} = 'proposed')`;
  const before: BatchItem<"sqlite">[] = [];
  let guard = sql`1 = 1`;
  let status: "approved" | "rejected" | "applied" = decision === "approve" ? "approved" : "rejected";
  let task: NodeRow | null = null;
  if (decision === "approve" && row.kind === "prompt_rule") {
    const staffId = StaffId.safeParse(row.staffId);
    if (!staffId.success) throw new AppError("conflict", "説明文の案に社員が無い");
    const [who] = await orm.select({ version: staff.promptVersion }).from(staff).where(eq(staff.id, staffId.data)).limit(1);
    if (!who) throw new AppError("conflict", "社員がいない");
    const [prompt] = await orm
      .select({ body: staffPrompts.body })
      .from(staffPrompts)
      .where(and(eq(staffPrompts.staffId, staffId.data), eq(staffPrompts.version, who.version)))
      .limit(1);
    const next = who.version + 1;
    const promptId = newId(clockAt(now));
    const body = `${prompt?.body ?? ""}\n- ${row.proposal}`.trimStart();
    const sameVersion = sql`EXISTS (SELECT 1 FROM ${staff} WHERE ${staff.id} = ${staffId.data} AND ${staff.promptVersion} = ${who.version})`;
    before.push(
      insertWhen(env.DB, staffPrompts, { id: promptId, staffId: staffId.data, version: next, body, by: actor.by, createdAt: now }, sql`${proposed} AND ${sameVersion}`),
      orm
        .update(staff)
        .set({ promptVersion: next })
        .where(and(eq(staff.id, staffId.data), eq(staff.promptVersion, who.version), proposed)),
    );
    // 説明文を書けた時だけ案を決める。版が変わっていれば案も決めない
    guard = sql`EXISTS (SELECT 1 FROM ${staffPrompts} WHERE ${staffPrompts.id} = ${promptId})`;
    status = "applied";
  }
  if (decision === "approve" && row.kind === "rule_tool") {
    const project = await intakeProject(env, "office", actor);
    task = await newNodeRow(
      env,
      { kind: "task", parentId: project.id, scope: "office", title: `ルールかツールを直す: ${row.cause}`, body: row.proposal, taskKind: "fix", assignee: "builder", source: `lesson:${row.id}` },
      actor,
    );
    before.push(insertWhen(env.DB, nodes, task, proposed));
  }
  const decide = orm
    .update(lessons)
    .set({ status, appliedAt: status === "applied" ? now : null })
    .where(and(eq(lessons.id, lessonId), eq(lessons.status, "proposed"), guard))
    .returning({ id: lessons.id });
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [decide];
  statements.unshift(...before);
  const results: unknown[] = await orm.batch(statements);
  if (z.array(z.unknown()).parse(results.at(-1)).length === 0) throw new AppError("conflict", "もう決めたか、説明文が変わった");
  if (task) {
    await recordCreated(env, task, actor);
    await notifyStaff(env, "builder", now, false);
  }
  return { lesson: toLesson({ ...row, status, appliedAt: status === "applied" ? now : null }), task };
}

/**
 * 基準を変える。読んだ版より新しい行が無い時だけ 1 文で足し、案を入れた事にするのも同じ 1 回で書く
 * @param env バインディング
 * @param input 版、変える項目、理由、入れる案
 * @param now 今の時刻
 * @returns 変えた後の版と値、変える前と後の項目
 * @throws validation_failed 知らない項目か、基準の形に合わない値の時
 * @throws not_found 入れる案が無い時
 * @throws conflict 版が違う時、案が承認した基準の案でない時
 */
export async function updateThresholds(
  env: Bindings,
  input: UpdateThresholdsInput,
  now: number,
): Promise<{ version: number; values: Thresholds; before: Record<string, number>; after: Record<string, number> }> {
  const current = await loadThresholds(env.DB);
  if (current.version !== input.version) throw new AppError("conflict", "バージョンが違う");
  const merged = Thresholds.safeParse({ ...current.thresholds, ...input.values });
  if (!merged.success) {
    throw new AppError("validation_failed", "基準の形に合わない", {
      errors: merged.error.issues.map((i) => ({ pointer: `#/values${i.path.length > 0 ? `/${i.path.map(String).join("/")}` : ""}`, detail: i.message })),
    });
  }
  const orm = drizzle(env.DB);
  if (input.lessonId !== undefined) {
    const [lesson] = await orm.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, input.lessonId)).limit(1);
    if (!lesson) throw new AppError("not_found", "案が無い");
  }
  const next = input.version + 1;
  const id = newId(clockAt(now));
  const newer = sql`NOT EXISTS (SELECT 1 FROM ${settings} WHERE ${settings.key} = 'guard.thresholds' AND ${settings.version} >= ${next})`;
  const approved =
    input.lessonId === undefined
      ? sql`1 = 1`
      : sql`EXISTS (SELECT 1 FROM ${lessons} WHERE ${lessons.id} = ${input.lessonId} AND ${lessons.kind} = 'threshold' AND ${lessons.status} = 'approved')`;
  const insert = insertWhen(
    env.DB,
    settings,
    { id, key: "guard.thresholds", scope: "office", value: merged.data, version: next, changedBy: "owner", reason: input.reason, createdAt: now },
    sql`${newer} AND ${approved}`,
  ).returning({ id: settings.id });
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [insert];
  if (input.lessonId !== undefined) {
    statements.push(
      orm
        .update(lessons)
        .set({ status: "applied", appliedAt: now })
        .where(and(eq(lessons.id, input.lessonId), eq(lessons.status, "approved"), sql`EXISTS (SELECT 1 FROM ${settings} WHERE ${settings.id} = ${id})`)),
    );
  }
  const results: unknown[] = await orm.batch(statements);
  if (z.array(z.unknown()).parse(results[0]).length === 0) throw new AppError("conflict", "バージョンが違うか、承認した基準の案でない");
  const keys = Object.keys(input.values).filter((k) => Reflect.get(current.thresholds, k) !== Reflect.get(merged.data, k));
  const pick = (t: Thresholds) => Object.fromEntries(keys.map((k) => [k, Number(Reflect.get(t, k))]));
  return { version: next, values: merged.data, before: pick(current.thresholds), after: pick(merged.data) };
}

/** 効き目を出す stops の行 */
const EffectStop = z.object({ at: z.number(), signal: z.string(), verdict: z.string().nullable() });
const Measure = z.object({ lessonId: z.string(), before: z.number().int(), after: z.number().int() });

/**
 * 自動停止の効き目を出す。止めた回数、判定した物のうち誤って止めた割合、多い原因、入れた対策の前後 7 日の止めた回数
 * @param db 今の状態の D1
 * @param range 日本時間の日の期間。to の日を含む
 * @param range.from 始めの日
 * @param range.to 終わりの日
 * @returns 効き目
 * @throws validation_failed from が to より後の時
 */
export async function guardEffect(db: D1Database, range: { from?: string | undefined; to?: string | undefined }): Promise<GuardEffect> {
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw new AppError("validation_failed", "from が to より後", { errors: [{ pointer: "#/query/from", detail: "to より前の日にする" }] });
  }
  const start = range.from === undefined ? 0 : jstDayStart(range.from);
  const end = range.to === undefined ? Number.MAX_SAFE_INTEGER : jstDayStart(range.to) + DAY;
  // 判定は最後の 1 件を使う
  const { results } = await db
    .prepare(
      `SELECT s.at, s.signal, (SELECT u.verdict FROM stop_updates u WHERE u.stop_id = s.id AND u.kind = 'verdict' ORDER BY u.at DESC, u.id DESC LIMIT 1) AS verdict
       FROM stops s WHERE s.kind = 'stop' AND s.at >= ? AND s.at < ? ORDER BY s.at`,
    )
    .bind(start, end)
    .all();
  const inRange = z.array(EffectStop).parse(results);
  const judged = inRange.filter((s) => s.verdict === "correct" || s.verdict === "false");
  const counts = new Map<string, number>();
  for (const s of inRange) counts.set(s.signal, (counts.get(s.signal) ?? 0) + 1);
  const topCauses = [...counts.entries()]
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, TOP_CAUSES)
    .map(([signal, count]) => ({ signal, count }));
  // 対策ごとに、同じ原因で止めた行だけを入れた時刻の前後 7 日で数える
  const same = "SELECT count(*) FROM stops s WHERE s.kind = 'stop' AND s.signal = l.cause";
  const { results: measured } = await db
    .prepare(
      `SELECT l.id AS lessonId,
         (${same} AND s.at >= l.applied_at - ? AND s.at < l.applied_at) AS before,
         (${same} AND s.at >= l.applied_at AND s.at < l.applied_at + ?) AS after
       FROM lessons l WHERE l.applied_at IS NOT NULL ORDER BY l.applied_at, l.id`,
    )
    .bind(MEASURE_MS, MEASURE_MS)
    .all();
  const measures = z.array(Measure).parse(measured);
  return { stops: inRange.length, falseRatio: judged.length === 0 ? 0 : judged.filter((s) => s.verdict === "false").length / judged.length, topCauses, measures };
}
