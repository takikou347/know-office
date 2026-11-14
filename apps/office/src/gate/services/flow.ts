// アイデアから運用までの流れ。案を足し、段階を移し、検討の材料を置き、サービスの詳細を組み立てる (サービスと拡張の 3.1)
import type { D1Database } from "@cloudflare/workers-types";
import {
  type AdvanceInput,
  AppError,
  CLOSABLE_STAGES,
  type CreateIdeaInput,
  NEXT_STAGES,
  newId,
  type ServiceCard,
  type ServiceDetail,
  type ServiceStage,
} from "@know-office/core";
import { and, asc, desc, eq, gt, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { services, serviceEvents } from "../db/main.ts";
import { serviceMetrics } from "../db/records.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import { notifyStaff } from "../work/loop.ts";
import { type Actor, createNode, intakeProject, recordsOf } from "../work/nodes.ts";

/** services の行 */
export type ServiceRow = typeof services.$inferSelect;

/** 検討の材料を置く R2 の鍵の頭 */
const STUDY_PREFIX = "studies/";

/** 社長に調べさせる事。案ごとのタスクの本文に並べる */
const STUDY_POINTS = ["似た物", "作る量", "セキュリティの要る所"] as const;

const iso = (at: number) => new Date(at).toISOString();

// service_events の detail は JSON のカラムなので、形を確かめてから返す
const EventDetail = z.record(z.string(), z.unknown());

/**
 * services の行を一覧の 1 件にする
 * @param row services の行
 * @returns 一覧の 1 件
 */
export function toCard(row: ServiceRow): ServiceCard {
  return { id: row.id, name: row.name, kind: row.kind, stage: row.stage, staffId: row.staffId, repo: row.repo };
}

/**
 * サービスの行を読む
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns services の行
 * @throws not_found サービスが無い時
 */
export async function findService(db: D1Database, serviceId: string): Promise<ServiceRow> {
  const [row] = await drizzle(db).select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!row) throw new AppError("not_found", "サービスが無い");
  return row;
}

/**
 * 段階の出来事を足す文を作る。読んだ段階のままの時だけ足し、同時に移した 2 つの片方を書かない
 * @param db 今の状態の D1
 * @param input サービス、読んだ段階、移る先、誰、中身
 * @param input.serviceId サービス ID
 * @param input.from 読んだ段階。null なら確かめない (足したばかりの案)
 * @param input.to 移る先
 * @param input.by `owner`、社員 ID、`system`
 * @param input.detail 理由などの中身
 * @param now 今の時刻
 * @returns D1 の batch に渡す文
 */
export function stageEvent(db: D1Database, input: { serviceId: string; from: ServiceStage | null; to: ServiceStage; by: string; detail: Record<string, unknown> }, now: number) {
  const values = { id: newId(clockAt(now)), at: now, serviceId: input.serviceId, kind: "stage" as const, by: input.by, detail: { ...input.detail, to: input.to } };
  const orm = drizzle(db);
  if (input.from === null) return orm.insert(serviceEvents).values(values);
  return orm
    .insert(serviceEvents)
    .select(
      sql`SELECT ${values.id}, ${values.at}, ${values.serviceId}, ${values.kind}, ${values.by}, ${JSON.stringify(values.detail)} WHERE EXISTS (SELECT 1 FROM ${services} WHERE ${services.id} = ${input.serviceId} AND ${services.stage} = ${input.from})`,
    );
}

/**
 * 案を足す。段階は idea で、足した事を service_events に残す
 * @param env バインディング
 * @param input 案の中身
 * @param actor 足した人。オーナーか社員
 * @returns 足したサービスの行
 */
export async function createIdea(env: Bindings, input: CreateIdeaInput, actor: Actor): Promise<ServiceRow> {
  const row: ServiceRow = {
    id: newId(clockAt(actor.now)),
    name: input.title,
    kind: input.kind,
    stage: "idea",
    ideaId: null,
    repo: null,
    staffId: null,
    aim: input.aim,
    users: input.users,
    costEstimate: input.costEstimateMicroUsd,
    revenueEstimate: input.revenueEstimateMicroUsd,
    studyKey: null,
    droppedReason: null,
    createdAt: actor.now,
  };
  const orm = drizzle(env.DB);
  await orm.batch([orm.insert(services).values(row), stageEvent(env.DB, { serviceId: row.id, from: null, to: "idea", by: actor.by, detail: {} }, actor.now)]);
  return row;
}

/**
 * 社長に、案を調べるタスクを足す。アイデアの検討はどのサービスにも入らないので office の受け付けの下に置く
 * @param env バインディング
 * @param row 検討に移したサービスの行
 * @param actor 移した人
 */
async function addStudyTask(env: Bindings, row: ServiceRow, actor: Actor): Promise<void> {
  const project = await intakeProject(env, "office", actor);
  const body = [`サービス ID: ${row.id}`, `狙い: ${row.aim ?? ""}`, `使う人: ${row.users ?? ""}`, `調べる事: ${STUDY_POINTS.join("、")}`, "調べた材料は study_submit で出す"].join("\n");
  await createNode(
    env,
    { kind: "task", parentId: project.id, scope: "office", title: `調べる: ${row.name}`, body, taskKind: "plan", assignee: "president", source: `study:${row.id}` },
    actor,
  );
  await notifyStaff(env, "president", actor.now, false);
}

/**
 * 段階を移す。移れる先だけを受け、読んだ段階のままの時だけ書く
 * @param env バインディング
 * @param serviceId サービス ID
 * @param input 移る先、理由、試作の担当
 * @param actor 移した人。今はオーナーだけ
 * @returns 移した後の行
 * @throws not_found サービスが無い時
 * @throws conflict 今の段階から移れない時、読んだ後に段階が変わった時
 * @throws validation_failed prototype に進めるのに担当の社員が無い時
 */
export async function advanceService(env: Bindings, serviceId: string, input: AdvanceInput, actor: Actor): Promise<ServiceRow> {
  const row = await findService(env.DB, serviceId);
  if (!NEXT_STAGES[row.stage].includes(input.to)) throw new AppError("conflict", "今の段階から移れない");
  if (input.to === "prototype" && input.staffId === undefined) {
    throw new AppError("validation_failed", "作ると決める時は担当の社員が要る", { errors: [{ pointer: "#/staffId", detail: "prototype に進める時に要る" }] });
  }
  const change: Partial<ServiceRow> = { stage: input.to };
  if (input.to === "prototype") change.staffId = input.staffId ?? null;
  if (input.to === "dropped") change.droppedReason = input.reason;
  const orm = drizzle(env.DB);
  // 出来事を先に足す。後の更新で段階が変わるので、出来事の条件は読んだ段階で見る
  const [, moved] = await orm.batch([
    stageEvent(env.DB, { serviceId, from: row.stage, to: input.to, by: actor.by, detail: { reason: input.reason } }, actor.now),
    orm
      .update(services)
      .set(change)
      .where(and(eq(services.id, serviceId), eq(services.stage, row.stage)))
      .returning(),
  ]);
  const [next] = moved;
  if (!next) throw new AppError("conflict", "段階が変わった");
  if (input.to === "study") await addStudyTask(env, next, actor);
  return next;
}

/**
 * 社長が調べた材料を R2 に置き、study_key で指す。検討の段階の案だけが受ける
 * @param env バインディング
 * @param serviceId サービス ID
 * @param body 材料の Markdown
 * @returns 置いた鍵
 * @throws not_found サービスが無い時
 * @throws conflict 検討の段階でない時
 */
export async function submitStudy(env: Bindings, serviceId: string, body: string): Promise<string> {
  const row = await findService(env.DB, serviceId);
  if (row.stage !== "study") throw new AppError("conflict", "検討の段階でない");
  const key = `${STUDY_PREFIX}${serviceId}.md`;
  await env.FILES.put(key, body, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  const moved = await drizzle(env.DB)
    .update(services)
    .set({ studyKey: key })
    .where(and(eq(services.id, serviceId), eq(services.stage, "study")))
    .returning({ id: services.id });
  if (moved.length === 0) throw new AppError("conflict", "検討の段階でない");
  return key;
}

/**
 * 社員の閉じる案を出せる段階かを確かめる
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns サービスの行
 * @throws not_found サービスが無い時
 * @throws conflict サービスか運用の段階でない時
 */
export async function closableService(db: D1Database, serviceId: string): Promise<ServiceRow> {
  const row = await findService(db, serviceId);
  if (!(CLOSABLE_STAGES as readonly ServiceStage[]).includes(row.stage)) throw new AppError("conflict", "閉じられる段階でない");
  return row;
}

/**
 * 一覧を段階で絞って、ID の順に 1 ページ読む
 * @param db 今の状態の D1
 * @param query 段階、カーソル、件数
 * @param query.stage 段階
 * @param query.cursor 前のページの最後の ID
 * @param query.limit 件数
 * @returns 1 ページと次のカーソル
 */
export async function listServices(db: D1Database, query: { stage?: ServiceStage | undefined; cursor?: string | undefined; limit: number }): Promise<{ items: ServiceCard[]; next: string | null }> {
  const rows = await drizzle(db)
    .select()
    .from(services)
    .where(and(query.stage === undefined ? undefined : eq(services.stage, query.stage), query.cursor === undefined ? undefined : gt(services.id, query.cursor)))
    .orderBy(asc(services.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return { items: page.map(toCard), next: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

/**
 * 最新のサービスの様子を、今の年の記録から読む
 * @param env バインディング
 * @param serviceId サービス ID
 * @param now 今の時刻
 * @returns 様子。まだ無ければ空
 */
async function latestMetrics(env: Bindings, serviceId: string, now: number): Promise<Record<string, unknown>> {
  const [row] = await drizzle(recordsOf(env, now)).select().from(serviceMetrics).where(eq(serviceMetrics.serviceId, serviceId)).orderBy(desc(serviceMetrics.at)).limit(1);
  if (!row) return {};
  return { at: iso(row.at), requests: row.requests, errors: row.errors, users: row.users, reads: row.reads };
}

/**
 * 検討の材料を R2 から読む
 * @param env バインディング
 * @param key study_key
 * @returns 材料。鍵が無いか R2 に無ければ null
 */
async function readStudy(env: Bindings, key: string | null): Promise<string | null> {
  if (key === null) return null;
  const object = await env.FILES.get(key);
  return object === null ? null : object.text();
}

/**
 * サービスの詳細を組み立てる。案とサービスは同じ行なので、元の案の中身と検討の材料も出す
 * @param env バインディング
 * @param serviceId サービス ID
 * @param now 今の時刻
 * @returns 詳細
 * @throws not_found サービスが無い時
 */
export async function loadService(env: Bindings, serviceId: string, now: number): Promise<ServiceDetail> {
  const row = await findService(env.DB, serviceId);
  const [events, metrics, study] = await Promise.all([
    // 同じミリ秒の出来事も書いた順に並べる
    drizzle(env.DB).select().from(serviceEvents).where(eq(serviceEvents.serviceId, serviceId)).orderBy(asc(serviceEvents.at), sql`rowid`),
    latestMetrics(env, serviceId, now),
    readStudy(env, row.studyKey),
  ]);
  return {
    ...toCard(row),
    aim: row.aim ?? "",
    users: row.users ?? "",
    costEstimateMicroUsd: row.costEstimate ?? 0,
    revenueEstimateMicroUsd: row.revenueEstimate ?? 0,
    study,
    droppedReason: row.droppedReason,
    metrics,
    events: events.map((e) => {
      const detail = EventDetail.safeParse(e.detail);
      return { at: iso(e.at), kind: e.kind, by: e.by, detail: detail.success ? detail.data : {} };
    }),
  };
}

/**
 * 閉じる案の承認で、サービスを閉じる文を作る。承認がまだ決まっていない時だけ書く
 * @param db 今の状態の D1
 * @param input サービス、承認、理由
 * @param input.serviceId サービス ID
 * @param input.from 読んだ段階
 * @param input.approvalId 承認の ID
 * @param input.reason 社員が出した理由
 * @param now 今の時刻
 * @param pending 承認がまだ決まっていない事を確かめる SQL の条件
 * @returns D1 の batch に渡す、出来事を足す文とサービスを閉じる文
 */
export function closeStatements(db: D1Database, input: { serviceId: string; from: ServiceStage; approvalId: string; reason: string }, now: number, pending: SQL) {
  const orm = drizzle(db);
  const event = { id: newId(clockAt(now)), detail: JSON.stringify({ reason: input.reason, approvalId: input.approvalId, to: "closed" }) };
  return [
    orm
      .insert(serviceEvents)
      .select(
        sql`SELECT ${event.id}, ${now}, ${input.serviceId}, 'stage', 'owner', ${event.detail} WHERE ${pending} AND EXISTS (SELECT 1 FROM ${services} WHERE ${services.id} = ${input.serviceId} AND ${services.stage} = ${input.from})`,
      ),
    orm
      .update(services)
      .set({ stage: "closed" })
      .where(and(eq(services.id, input.serviceId), eq(services.stage, input.from), pending)),
  ] as const;
}
