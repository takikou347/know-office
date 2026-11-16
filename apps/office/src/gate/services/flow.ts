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
import { and, asc, eq, gt, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { nodes, services, serviceEvents } from "../db/main.ts";
import { insertWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import { notifyStaff } from "../work/loop.ts";
import type { TokenDeps } from "../github/app.ts";
import { requireDocsRepo } from "../devloop/docs-repo.ts";
import { chooseRepo } from "./repo.ts";
import { serviceStatus } from "./status.ts";
import { type Actor, intakeProject, newNodeRow, type NodeRow, recordCreated } from "../work/nodes.ts";

/** services の行 */
export type ServiceRow = typeof services.$inferSelect;

/** 検討の材料を置く R2 の鍵の頭 */
const STUDY_PREFIX = "studies/";

/** 社長に調べさせる事。案ごとのタスクの本文に並べる */
const STUDY_POINTS = ["似た物", "作る量", "セキュリティの要る所"] as const;

const iso = (at: number) => new Date(at).toISOString();

// service_events の detail は JSON のカラムなので、形を確かめてから返す
const EventDetail = z.record(z.string(), z.unknown());

// batch の最後の更新が返した行
const Moved = z.array(z.object({ id: z.string() }));

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
 * サービスが読んだ段階のままかを確かめる SQL の条件を作る
 * @param serviceId サービス ID
 * @param stage 読んだ段階
 * @returns SQL の条件
 */
export function stillAt(serviceId: string, stage: ServiceStage): SQL {
  return sql`EXISTS (SELECT 1 FROM ${services} WHERE ${services.id} = ${serviceId} AND ${services.stage} = ${stage})`;
}

/**
 * 段階の出来事の行を作る
 * @param input サービス、移る先、誰、中身
 * @param input.serviceId サービス ID
 * @param input.to 移る先
 * @param input.by `owner`、社員 ID、`system`
 * @param input.detail 理由などの中身
 * @param now 今の時刻
 * @returns service_events の行
 */
function stageEvent(input: { serviceId: string; to: ServiceStage; by: string; detail: Record<string, unknown> }, now: number): typeof serviceEvents.$inferSelect {
  return { id: newId(clockAt(now)), at: now, serviceId: input.serviceId, kind: "stage", by: input.by, detail: { ...input.detail, to: input.to } };
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
  await orm.batch([orm.insert(services).values(row), orm.insert(serviceEvents).values(stageEvent({ serviceId: row.id, to: "idea", by: actor.by, detail: {} }, actor.now))]);
  return row;
}

/**
 * 社長に案を調べさせるタスクの行を組み立てる。アイデアの検討はどのサービスにも入らないので office の受け付けの下に置く。書くのは段階の更新と同じ batch
 * @param env バインディング
 * @param row 検討に移すサービスの行
 * @param actor 移す人
 * @returns nodes の行
 */
async function studyTask(env: Bindings, row: ServiceRow, actor: Actor): Promise<NodeRow> {
  const project = await intakeProject(env, "office", actor);
  const body = [`サービス ID: ${row.id}`, `狙い: ${row.aim ?? ""}`, `使う人: ${row.users ?? ""}`, `調べる事: ${STUDY_POINTS.join("、")}`, "調べた材料は study_submit で出す"].join("\n");
  return newNodeRow(env, { kind: "task", parentId: project.id, scope: "office", title: `調べる: ${row.name}`, body, taskKind: "plan", assignee: "president", source: `study:${row.id}` }, actor);
}

/**
 * 同じ名前 (`owner/name` の name。大文字小文字を分けない) のリポジトリを持つ別のサービスが無い事の SQL の条件を作る。設計書の置き場 `services/<名前>/` が重なるので、あれば 409 にする
 * @param db 今の状態の D1
 * @param serviceId 進めるサービス
 * @param repo 選ぶリポジトリ
 * @returns SQL の条件
 * @throws conflict 今あれば
 */
async function sameNameCondition(db: D1Database, serviceId: string, repo: string): Promise<SQL> {
  const name = (repo.split("/")[1] ?? repo).toLowerCase();
  const none = sql`NOT EXISTS (SELECT 1 FROM ${services} WHERE ${services.id} <> ${serviceId} AND lower(substr(${services.repo}, instr(${services.repo}, '/') + 1)) = ${name})`;
  const [found] = await drizzle(db).select({ id: services.id }).from(services).where(sql`${services.id} <> ${serviceId} AND lower(substr(${services.repo}, instr(${services.repo}, '/') + 1)) = ${name}`).limit(1);
  if (found !== undefined) throw new AppError("conflict", "同じ名前のリポジトリを持つ別のサービスがある。設計書の置き場が重なる");
  return none;
}

/**
 * 試作に進める案の、設計書を書くタスクの行を組み立てる。開発担当が設計書のリポジトリの `services/<名前>/` に書く。書くのは段階の更新と同じ batch
 * @param env バインディング
 * @param row 試作に進めるサービスの行
 * @param repo サービスのリポジトリ
 * @param docsRepo 設計書のリポジトリ
 * @param actor 移す人
 * @returns nodes の行
 */
async function designTask(env: Bindings, row: ServiceRow, repo: string, docsRepo: string, actor: Actor): Promise<NodeRow> {
  const project = await intakeProject(env, row.id, actor);
  const dir = `services/${repo.split("/")[1] ?? repo}/`;
  const body = [`サービス ID: ${row.id}`, `設計書のリポジトリ: ${docsRepo}`, `書く置き場: ${dir}`, "形はそのリポジトリの services/WRITING.md に従う", "書いたら pr_open で PR を出す。最初の設計書はオーナーが読んで承認した物だけが main に入る"].join("\n");
  return newNodeRow(env, { kind: "task", parentId: project.id, scope: row.id, title: `設計書: ${row.name}`, body, taskKind: "build", assignee: "builder", repo: docsRepo, source: `design:${row.id}` }, actor);
}

/**
 * 段階を移す。移れる先だけを受け、読んだ段階のままの時だけ書く
 * @param env バインディング
 * @param serviceId サービス ID
 * @param input 移る先、理由、試作の担当
 * @param actor 移した人。今はオーナーだけ
 * @param github リポジトリを確かめる GitHub の鍵の出し手
 * @returns 移した後の行
 * @throws not_found サービスが無い時
 * @throws conflict 今の段階から移れない時、読んだ後に段階か GitHub との連携か設計書のリポジトリが変わった時、GitHub とつないでいないのにリポジトリを選んだ時、設計書のリポジトリが無いか使えない時、リポジトリが設計書のリポジトリと同じか、同じ名前のリポジトリを持つ別のサービスがある時
 * @throws validation_failed prototype に進めるのに担当の社員かリポジトリが無い時、ほかの段階にリポジトリを送った時、触れるリポジトリに無い時
 * @throws upstream_failed 触れるリポジトリを GitHub から読めない時
 */
export async function advanceService(env: Bindings, serviceId: string, input: AdvanceInput, actor: Actor, github: TokenDeps): Promise<ServiceRow> {
  const row = await findService(env.DB, serviceId);
  if (!NEXT_STAGES[row.stage].includes(input.to)) throw new AppError("conflict", "今の段階から移れない");
  const prototype = input.to === "prototype";
  const missing = [
    ...(prototype && input.staffId === undefined ? [{ pointer: "#/staffId", detail: "prototype に進める時に要る" }] : []),
    ...(prototype && input.repo === undefined ? [{ pointer: "#/repo", detail: "prototype に進める時に要る" }] : []),
    // 登録の時に決める項目なので、ほかの段階では受けない。後から変えるのは設定で行う
    ...(!prototype && input.repo !== undefined ? [{ pointer: "#/repo", detail: "prototype に進める時だけ送る" }] : []),
  ];
  if (missing.length > 0) throw new AppError("validation_failed", "作ると決める時は担当の社員とリポジトリが要る", { errors: missing });
  // TODO(#71): service に進める時は、サービスの deployWhen のチェックとレビュー担当の承認を GitHub から確かめる
  const change: Partial<ServiceRow> = { stage: input.to };
  if (prototype) {
    change.staffId = input.staffId ?? null;
    change.repo = input.repo ?? null;
  }
  if (input.to === "dropped") change.droppedReason = input.reason;
  const orm = drizzle(env.DB);
  // リポジトリは確かめた時の連携のままの時だけ書く。連携が変われば、段階も変えない
  // 試作に進める時は、設計書のリポジトリが使える事を先に確かめる。使えなければ段階も変えない
  const docs = prototype ? await requireDocsRepo(env, github) : null;
  const linked = prototype && input.repo !== undefined ? await chooseRepo(env, github, input.repo, "#/repo") : undefined;
  const sameName = prototype && input.repo !== undefined ? await sameNameCondition(env.DB, serviceId, input.repo) : undefined;
  const task = input.to === "study" ? await studyTask(env, row, actor) : docs !== null && input.repo !== undefined ? await designTask(env, row, input.repo, docs.repo, actor) : null;
  // 設計書のリポジトリの版、連携、同じ名前のサービスが無い事も、書く時に重ねる
  const conditions = [stillAt(serviceId, row.stage), linked, docs?.still, sameName].filter((c): c is SQL => c !== undefined);
  const still = and(...conditions) ?? stillAt(serviceId, row.stage);
  // 出来事と調べるタスクを先に足す。後の更新で段階が変わるので、どれも読んだ段階のままの時だけ書く。1 つでも失敗すれば全部を書かない
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    insertWhen(env.DB, serviceEvents, stageEvent({ serviceId, to: input.to, by: actor.by, detail: { reason: input.reason } }, actor.now), still),
    ...(task ? [insertWhen(env.DB, nodes, task, still)] : []),
    orm
      .update(services)
      .set(change)
      .where(and(eq(services.id, serviceId), eq(services.stage, row.stage), linked, docs?.still, sameName))
      .returning({ id: services.id }),
  ];
  const results: unknown[] = await orm.batch(statements);
  if (Moved.parse(results.at(-1)).length === 0) throw new AppError("conflict", "段階か GitHub との連携が変わった");
  if (task) {
    await recordCreated(env, task, actor);
    // 調べるタスクは社長、設計書を書くタスクは開発担当を呼ぶ
    await notifyStaff(env, task.assignee ?? "president", actor.now, false);
  }
  return { ...row, ...change };
}

/**
 * 社長が調べた材料を R2 に置き、study_key で指す。検討の段階の案だけが受ける。2 度目に出すと新しい材料に替わる。前の材料は R2 に残し、上書きしない
 * @param env バインディング
 * @param serviceId サービス ID
 * @param body 材料の Markdown
 * @param now 今の時刻
 * @returns 置いた鍵
 * @throws not_found サービスが無い時
 * @throws conflict 検討の段階でない時。置いている間に段階が変わった時は、置いた材料を消す
 */
export async function submitStudy(env: Bindings, serviceId: string, body: string, now: number): Promise<string> {
  const row = await findService(env.DB, serviceId);
  if (row.stage !== "study") throw new AppError("conflict", "検討の段階でない");
  // 出すたびに鍵を変え、study_key を替えるまで前の材料を読めるままにする
  const key = `${STUDY_PREFIX}${serviceId}/${newId(clockAt(now))}.md`;
  await env.FILES.put(key, body, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  const moved = await drizzle(env.DB)
    .update(services)
    .set({ studyKey: key })
    .where(and(eq(services.id, serviceId), eq(services.stage, "study")))
    .returning({ id: services.id });
  if (moved.length === 0) {
    await env.FILES.delete(key);
    throw new AppError("conflict", "検討の段階でない");
  }
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
  const [events, status, study] = await Promise.all([
    // 同じミリ秒の出来事も書いた順に並べる
    drizzle(env.DB).select().from(serviceEvents).where(eq(serviceEvents.serviceId, serviceId)).orderBy(asc(serviceEvents.at), sql`rowid`),
    serviceStatus(env, row, now),
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
    status,
    events: events.map((e) => {
      const detail = EventDetail.safeParse(e.detail);
      return { at: iso(e.at), kind: e.kind, by: e.by, detail: detail.success ? detail.data : {} };
    }),
  };
}

/**
 * 閉じる案の承認で、サービスを閉じる文を作る。承認を書いた後に置き、この承認が承認済みで、サービスが読んだ段階のままの時だけ書く
 * @param db 今の状態の D1
 * @param input サービス、承認、理由
 * @param input.serviceId サービス ID
 * @param input.from 読んだ段階
 * @param input.approvalId 承認の ID
 * @param input.reason 社員が出した理由
 * @param now 今の時刻
 * @param approved この承認を承認済みにした事を確かめる SQL の条件
 * @returns D1 の batch に渡す、出来事を足す文とサービスを閉じる文
 */
export function closeStatements(db: D1Database, input: { serviceId: string; from: ServiceStage; approvalId: string; reason: string }, now: number, approved: SQL): BatchItem<"sqlite">[] {
  const when = and(approved, stillAt(input.serviceId, input.from)) ?? approved;
  const event = stageEvent({ serviceId: input.serviceId, to: "closed", by: "owner", detail: { reason: input.reason, approvalId: input.approvalId } }, now);
  return [
    insertWhen(db, serviceEvents, event, when),
    drizzle(db)
      .update(services)
      .set({ stage: "closed" })
      .where(and(eq(services.id, input.serviceId), eq(services.stage, input.from), approved)),
  ];
}
