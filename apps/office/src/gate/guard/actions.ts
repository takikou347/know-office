// 範囲ごとに止める動き、止めた記録と近かった記録、再開、止める前に見せる数 (自動停止の 3.2、3.4、3.5、3.6、3.7)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type GuardScope, type Judgment, newId, StaffId, type StopPreview } from "@know-office/core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { rotateVaultKeys } from "../auth/vault.ts";
import { nodes, notices, services, sessions, staff, stops, stopUpdates } from "../db/main.ts";
import type { Bindings, Guard, Staff } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import type { GuardDeps, RecentOp } from "./deps.ts";

/** stops の 1 行 */
export type StopRowData = typeof stops.$inferSelect;

/** 止める時に残す中身 */
export type StopInput = Pick<Judgment, "scope" | "target" | "signal" | "measured" | "threshold"> & {
  /** 止めた者 */
  by: "system" | "owner";
  /** その時の基準のバージョン */
  rulesVersion: number;
  /** 直前の 20 件の出来事 */
  recentOps: RecentOp[];
  /** 読んでいた外部の文章の出所 */
  externalSources: string[];
  /** オーナーが手で止めた理由 */
  reason?: string;
  /** 要求のトレース ID */
  traceId?: string;
};

const SCOPE_LABEL: Record<GuardScope, string> = { task: "タスク", staff: "社員", service: "サービス", office: "全体" };

const ALL_STAFF = StaffId.options;

/**
 * 社員 ID を役割の順に並べる
 * @param ids 社員 ID。重なりと null を含んでよい
 * @returns 役割の順の社員 ID
 */
const ordered = (ids: (string | null)[]) => ALL_STAFF.filter((id) => ids.includes(id));
const NodeProgress = z.object({ staffId: StaffId.nullable(), progress: z.unknown() }).loose();

/**
 * 社員 DO を返す
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns StaffDO の RPC
 */
export function staffOf(env: Bindings, staffId: StaffId): Staff {
  return env.STAFF.get(env.STAFF.idFromName(staffId));
}

/**
 * 全体のセキュリティ DO を返す
 * @param env バインディング
 * @returns GuardDO の RPC
 */
export function guardDo(env: Bindings): Guard {
  return env.GUARD.get(env.GUARD.idFromName("guard"));
}

/**
 * まだ再開していない、その範囲と相手の止めた記録を返す
 * @param db 今の状態の D1
 * @param scope 範囲
 * @param target 相手
 * @returns 止めた記録。無ければ null
 */
export async function openStop(db: D1Database, scope: GuardScope, target: string): Promise<StopRowData | null> {
  const [row] = await openStops(db, and(eq(stops.scope, scope), eq(stops.target, target)));
  return row ?? null;
}

/**
 * まだ再開していない止めた記録を新しい順に返す
 * @param db 今の状態の D1
 * @param where 足す条件
 * @returns 止めた記録
 */
export async function openStops(db: D1Database, where?: ReturnType<typeof and>): Promise<StopRowData[]> {
  const resumed = sql`NOT EXISTS (SELECT 1 FROM stop_updates u WHERE u.stop_id = ${stops.id} AND u.kind = 'resumed')`;
  return drizzle(db)
    .select()
    .from(stops)
    .where(and(eq(stops.kind, "stop"), resumed, where))
    .orderBy(desc(stops.id));
}

/**
 * 監査ログに 1 行頼む。止める動きはルートの外 (DO の数え方と定期ジョブ) からも呼ぶので、文脈を受けずに書く
 * @param env バインディング
 * @param entry 中身
 * @param entry.at 時刻
 * @param entry.actor owner か system
 * @param entry.action 何をしたか
 * @param entry.target 止めた記録の ID
 * @param entry.detail 中身
 * @param entry.traceId 要求のトレース ID
 */
async function record(env: Bindings, entry: { at: number; actor: string; action: string; target: string; detail: unknown; traceId?: string | undefined }): Promise<void> {
  const recorder = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
  await recorder.append({ ...entry, scope: "office", ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }) });
}

/**
 * 止めた記録と通知と監査ログを先に残し、その後に範囲ごとに止める。同じ相手への止めが同時に来ても、記録は 1 行だけ
 * 止める動きが途中で失敗しても記録は残り、失敗した事を通知、監査ログ、エラーログに残してから投げる
 * @param env バインディング
 * @param input 止める範囲とシグナル
 * @param now 今の時刻
 * @param deps 外へ頼む口
 * @returns 止めた記録の ID。もう止めていれば null
 * @throws internal 止める動きが途中で失敗した時
 */
export async function applyStop(env: Bindings, input: StopInput, now: number, deps: GuardDeps): Promise<string | null> {
  if (await openStop(env.DB, input.scope, input.target)) return null;
  const orm = drizzle(env.DB);
  const stopId = newId(clockAt(now));
  // 止める権利は GuardDO の中で 1 つずつ渡すので、同時に来た 2 つ目はここで返る
  if (!(await guardDo(env).claimStop(input.scope, input.target, stopId))) return null;
  const subject = await subjectOf(env.DB, input);
  try {
    await orm.batch([
      orm.insert(stops).values({
        id: stopId,
        at: now,
        kind: "stop",
        scope: input.scope,
        target: input.target,
        signal: input.signal,
        measured: input.measured,
        threshold: input.threshold,
        rulesVersion: input.rulesVersion,
        recentOpsKey: null,
        nodeProgress: subject.nodeProgress,
        externalSources: input.externalSources,
        model: subject.model,
        by: input.by,
      }),
      orm.insert(notices).values(notice(now, "stop", "guard_stop", `${SCOPE_LABEL[input.scope]}を止めた`, input.reason ?? `${input.signal}: ${String(input.measured)} / ${String(input.threshold)}`)),
    ]);
  } catch (error) {
    await guardDo(env).dropClaim(stopId);
    throw error;
  }
  // 直前の 20 件の出来事は、止めた記録と同じ時に監査ログの detail に残す
  await record(env, {
    at: now,
    actor: input.by,
    action: "guard.stop",
    target: stopId,
    detail: { scope: input.scope, target: input.target, signal: input.signal, measured: input.measured, threshold: input.threshold, reason: input.reason ?? null, recentOps: input.recentOps },
    traceId: input.traceId,
  });
  try {
    await enforce(env, input, subject.staffId, now, deps);
  } catch (error) {
    await orm.insert(notices).values(notice(now, "stop", "guard_stop_failed", `${SCOPE_LABEL[input.scope]}を止める動きが途中で失敗した`, "止めた記録は残っている。止まっていない所があるので、記録を確かめる"));
    await record(env, { at: now, actor: "system", action: "guard.stop_failed", target: stopId, detail: { scope: input.scope, target: input.target }, traceId: input.traceId });
    await recordError(env, { source: "gate", level: "error", code: "guard_stop_failed", error }, clockAt(now));
    throw new AppError("internal", "止める動きが途中で失敗した");
  }
  return stopId;
}

/**
 * 止める相手にひもづく社員とタスクの経過を読む。記録に残すだけで、何も変えない
 * @param db 今の状態の D1
 * @param input 止める範囲と相手
 * @returns 社員、使っていたモデル、タスクの経過
 */
async function subjectOf(db: D1Database, input: StopInput): Promise<{ staffId: StaffId | null; model: string | null; nodeProgress: unknown }> {
  const orm = drizzle(db);
  let staffId: StaffId | null = null;
  let nodeProgress: unknown = null;
  if (input.scope === "task") {
    const [node] = await orm.select().from(nodes).where(eq(nodes.id, input.target)).limit(1);
    const assignee = StaffId.safeParse(node?.assignee);
    staffId = assignee.success ? assignee.data : null;
    nodeProgress = { staffId, progress: node?.progress ?? null };
  }
  if (input.scope === "staff") staffId = StaffId.parse(input.target);
  const [row] = staffId ? await orm.select({ model: staff.model }).from(staff).where(eq(staff.id, staffId)).limit(1) : [];
  return { staffId, model: row?.model ?? null, nodeProgress };
}

/**
 * 範囲ごとに止める動きを効かせる
 * @param env バインディング
 * @param input 止める範囲と相手
 * @param staffId タスクを持っていた社員
 * @param now 今の時刻
 * @param deps 外へ頼む口
 */
async function enforce(env: Bindings, input: StopInput, staffId: StaffId | null, now: number, deps: GuardDeps): Promise<void> {
  const orm = drizzle(env.DB);
  switch (input.scope) {
    case "task": {
      const [node] = await orm.select().from(nodes).where(eq(nodes.id, input.target)).limit(1);
      // タスクは上司に戻す。上司がいなければ持っていた社員のまま
      const [boss] = staffId ? await orm.select({ bossId: staff.bossId }).from(staff).where(eq(staff.id, staffId)).limit(1) : [];
      if (node) await orm.update(nodes).set({ status: "stopped", assignee: boss?.bossId ?? node.assignee, updatedAt: now }).where(eq(nodes.id, node.id));
      if (staffId) await staffOf(env, staffId).dropTask(input.target, now);
      return;
    }
    case "staff":
      await staffOf(env, StaffId.parse(input.target)).halt(now);
      return;
    case "service": {
      const [service] = await orm.select({ kind: services.kind }).from(services).where(eq(services.id, input.target)).limit(1);
      // ライブラリは公開を断るだけで、戻すのは Web アプリだけ。戻せなくても、止めた記録が開いている間は公開を断る
      if (service?.kind !== "web_app") return;
      try {
        await deps.rollback(input.target);
      } catch (error) {
        await orm.insert(notices).values(notice(now, "stop", "guard_rollback_failed", `${input.target} を前のバージョンに戻せなかった`, "公開は止めている。前のバージョンへは手で戻す"));
        await recordError(env, { source: "gate", level: "error", code: "guard_rollback_failed", error }, clockAt(now));
      }
      return;
    }
    case "office":
      for (const id of ALL_STAFF) await staffOf(env, id).halt(now);
      await orm.update(sessions).set({ endedAt: now }).where(isNull(sessions.endedAt));
      await rotateVaultKeys(env.DB, env.MASTER_KEY, now);
      await guardDo(env).holdKeys();
      return;
    default:
      input.scope satisfies never;
  }
}

/**
 * 通知の行を作る
 * @param now 今の時刻
 * @param level warn か stop
 * @param kind 通知の種類
 * @param title 題
 * @param body 中身
 * @returns notices に足す値
 */
function notice(now: number, level: "warn" | "stop", kind: string, title: string, body: string): typeof notices.$inferInsert {
  return { id: newId(clockAt(now)), at: now, level, kind, title, body, scope: "office" };
}

/**
 * 近かった記録と通知と監査ログを残す
 * @param env バインディング
 * @param input 近かった範囲とシグナル
 * @param now 今の時刻
 * @returns 近かった記録の ID
 */
export async function recordNear(env: Bindings, input: Omit<StopInput, "by" | "reason">, now: number): Promise<string> {
  const orm = drizzle(env.DB);
  const id = newId(clockAt(now));
  await orm.batch([
    orm.insert(stops).values({
      id,
      at: now,
      kind: "near",
      scope: input.scope,
      target: input.target,
      signal: input.signal,
      measured: input.measured,
      threshold: input.threshold,
      rulesVersion: input.rulesVersion,
      externalSources: input.externalSources,
      by: "system",
    }),
    orm.insert(notices).values({
      id: newId(clockAt(now)),
      at: now,
      level: "warn",
      kind: "guard_near",
      title: `${SCOPE_LABEL[input.scope]}を止める基準に近かった`,
      body: `${input.signal}: ${String(input.measured)} / ${String(input.threshold)}`,
      scope: "office",
    }),
  ]);
  await record(env, { at: now, actor: "system", action: "guard.near", target: id, detail: { scope: input.scope, target: input.target, signal: input.signal, recentOps: input.recentOps } });
  return id;
}

/**
 * 止めた記録を再開する。タスクは最後の経過から続け、タスクの数を 0 に戻す
 * @param env バインディング
 * @param stop 止めた記録
 * @param by 再開した者
 * @param reason 再開の理由
 * @param now 今の時刻
 * @param traceId 要求のトレース ID
 * @returns 再開したか。同じ記録の再開が同時に来た時の 2 つ目は false
 */
export async function resumeStop(env: Bindings, stop: StopRowData, by: "reviewer" | "owner", reason: string | null, now: number, traceId?: string): Promise<boolean> {
  // 再開する権利は GuardDO の中で 1 つずつ渡すので、resumed の行は 1 つだけになる
  if (!(await guardDo(env).releaseStop(stop.id))) return false;
  const orm = drizzle(env.DB);
  switch (stop.scope) {
    case "task": {
      const progress = NodeProgress.safeParse(stop.nodeProgress);
      const staffId = progress.success ? progress.data.staffId : null;
      await orm
        .update(nodes)
        .set({ status: "todo", ...(staffId ? { assignee: staffId } : {}), updatedAt: now })
        .where(eq(nodes.id, stop.target));
      if (staffId) await staffOf(env, staffId).resumeTask(stop.target);
      break;
    }
    case "staff":
      await staffOf(env, StaffId.parse(stop.target)).resume(now);
      break;
    case "office":
      for (const id of ALL_STAFF) await staffOf(env, id).resume(now);
      break;
    default:
      // サービスは止めた記録が開いている間だけ公開を断るので、記録を閉じれば戻る
      break;
  }
  await orm.insert(stopUpdates).values({ id: newId(clockAt(now)), stopId: stop.id, at: now, kind: "resumed", by, reason });
  await record(env, { at: now, actor: by === "owner" ? "owner" : "system", action: "guard.resume", target: stop.id, detail: { scope: stop.scope, target: stop.target, by, reason }, traceId });
  return true;
}

/**
 * タスクと社員の止めた記録をレビュー担当に渡し、問題が無いと返れば再開する。問題があれば正しく止めたと判定を残す
 * @param env バインディング
 * @param stopId 止めた記録の ID
 * @param input 止めた中身
 * @param now 今の時刻
 * @param deps 外へ頼む口
 * @returns 無し
 */
export async function askReviewer(env: Bindings, stopId: string, input: StopInput, now: number, deps: GuardDeps): Promise<void> {
  if (input.scope !== "task" && input.scope !== "staff") return;
  const answer = await deps.review({ stopId, scope: input.scope, target: input.target, signal: input.signal, measured: input.measured, threshold: input.threshold, recentOps: input.recentOps });
  if (!answer) return;
  const [stop] = await drizzle(env.DB).select().from(stops).where(eq(stops.id, stopId)).limit(1);
  if (!stop) return;
  if (answer.resume) {
    await resumeStop(env, stop, "reviewer", answer.reason, now);
    return;
  }
  await drizzle(env.DB).insert(stopUpdates).values({ id: newId(clockAt(now)), stopId, at: now, kind: "verdict", by: "reviewer", verdict: "correct", reason: answer.reason });
}

/**
 * 止める前に、止まる社員とタスクの数を数える。データは変えない
 * @param db 今の状態の D1
 * @param scope 範囲
 * @param target 相手
 * @returns 止まる社員と、止まるタスクの数
 * @throws not_found 相手が無い時
 */
export async function previewStop(db: D1Database, scope: GuardScope, target: string): Promise<StopPreview> {
  const orm = drizzle(db);
  const doing = (where?: ReturnType<typeof and>) =>
    orm
      .select({ assignee: nodes.assignee })
      .from(nodes)
      .where(and(eq(nodes.kind, "task"), eq(nodes.status, "doing"), where));
  switch (scope) {
    case "task": {
      const [node] = await orm.select().from(nodes).where(and(eq(nodes.id, target), eq(nodes.kind, "task"))).limit(1);
      if (!node) throw new AppError("not_found", "タスクが無い");
      return { staff: ordered([node.assignee]), nodes: 1 };
    }
    case "staff": {
      const id = StaffId.safeParse(target);
      if (!id.success) throw new AppError("not_found", "社員が無い");
      return { staff: [id.data], nodes: (await doing(eq(nodes.assignee, id.data))).length };
    }
    case "service": {
      const [service] = await orm.select({ id: services.id }).from(services).where(eq(services.id, target)).limit(1);
      if (!service) throw new AppError("not_found", "サービスが無い");
      const held = await doing(eq(nodes.scope, target));
      return { staff: ordered(held.map((n) => n.assignee)), nodes: held.length };
    }
    case "office":
      if (target !== "office") throw new AppError("not_found", "全体の相手は office");
      return { staff: [...ALL_STAFF], nodes: (await doing()).length };
    default:
      return scope satisfies never;
  }
}

/**
 * 止めた記録の再開と判定を読む
 * @param db 今の状態の D1
 * @param ids 止めた記録の ID
 * @returns 止めた記録ごとの、再開した時刻と最後の判定
 */
export async function stopStates(db: D1Database, ids: string[]): Promise<Map<string, { resumedAt: number | null; verdict: string | null }>> {
  const out = new Map<string, { resumedAt: number | null; verdict: string | null }>();
  if (ids.length === 0) return out;
  const updates = await drizzle(db).select().from(stopUpdates).where(inArray(stopUpdates.stopId, ids)).orderBy(stopUpdates.id);
  for (const id of ids) out.set(id, { resumedAt: null, verdict: null });
  for (const u of updates) {
    const state = out.get(u.stopId);
    if (!state) continue;
    if (u.kind === "resumed" && state.resumedAt === null) state.resumedAt = u.at;
    if (u.kind === "verdict") state.verdict = u.verdict;
  }
  return out;
}
