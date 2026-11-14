// 目的からタスクまでの木。作る、変える、読む、受け付ける、出来事を残す (タスクとレビューの 3.1、データの 2.5)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, jstYear, newId, type Node, type NodeEvent, type NodeKind, type NodeStatus, type NodeTree, type StaffId, type TaskKind } from "@know-office/core";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { nodes, staff } from "../db/main.ts";
import { nodeEvents } from "../db/records.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { auditFrom } from "../ledger/record.ts";
import { clockAt } from "./attendance.ts";

/** nodes の行 */
export type NodeRow = typeof nodes.$inferSelect;

/** 書く時に添える、誰がいつ */
export type Actor = {
  /** owner、社員 ID、system */
  by: string;
  /** 今の時刻 */
  now: number;
  /** 要求のトレース ID。要求の外なら無し */
  traceId?: string | undefined;
};

/** 種類ごとに、親に置ける種類。目的は親を持たない */
const PARENT_KIND: Record<NodeKind, NodeKind | null> = { purpose: null, goal: "purpose", project: "goal", task: "project" };

/** 優先度を付けない時の値。小さいほど先に取る */
export const DEFAULT_PRIORITY = 100;

/** 受け付けのプロジェクトの名前 */
const INTAKE_TITLE = "受け付け";

const Detail = z.record(z.string(), z.unknown());

/**
 * 時刻の年の記録の D1 を返す
 * @param env バインディング
 * @param at 時刻
 * @returns REC_<年>
 * @throws internal その年の記録の D1 が無い時
 */
function recordsOf(env: Bindings, at: number): D1Database {
  const name = RECORD_BINDINGS.find((b) => b === `REC_${String(jstYear(at))}`);
  const db = name ? env[name] : undefined;
  if (!db) throw new AppError("internal", "その年の記録の D1 が無い");
  return db;
}

/**
 * タスクの出来事を node_events に 1 行足す
 * @param env バインディング
 * @param input 出来事
 * @param input.nodeId タスク ID
 * @param input.staffId 起こした社員。オーナーとゲートウェイは null
 * @param input.kind 出来事の種類 (created、started、review_rejected など)
 * @param input.detail 中身。鍵やオーナーの情報は入れない
 * @param actor 時刻とトレース ID
 */
export async function appendNodeEvent(env: Bindings, input: { nodeId: string; staffId: string | null; kind: string; detail: Record<string, unknown> }, actor: Actor): Promise<void> {
  await drizzle(recordsOf(env, actor.now))
    .insert(nodeEvents)
    .values({ id: newId(clockAt(actor.now)), at: actor.now, nodeId: input.nodeId, staffId: input.staffId, kind: input.kind, detail: input.detail, traceId: actor.traceId ?? null });
}

/**
 * 1 件を読む
 * @param db 今の状態の D1
 * @param id ID
 * @returns 行
 * @throws not_found 無い時
 */
export async function findNode(db: D1Database, id: string): Promise<NodeRow> {
  const [row] = await drizzle(db).select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!row) throw new AppError("not_found", "木の 1 件が無い");
  return row;
}

/**
 * 親が階層の順に合う事を確かめる
 * @param db 今の状態の D1
 * @param kind 置く物の種類
 * @param parentId 親の ID
 * @param scope 置く物の範囲
 * @throws not_found 親が無い時
 * @throws conflict 親の種類が階層に合わない時、範囲が違う時
 */
async function checkParent(db: D1Database, kind: NodeKind, parentId: string | undefined, scope: string): Promise<void> {
  const want = PARENT_KIND[kind];
  if (want === null) {
    if (parentId !== undefined) throw new AppError("conflict", "目的は親を持たない");
    return;
  }
  if (parentId === undefined) throw new AppError("conflict", "目的のほかは親が要る");
  const parent = await findNode(db, parentId);
  if (parent.kind !== want) throw new AppError("conflict", "親の種類が階層に合わない");
  if (parent.scope !== scope) throw new AppError("conflict", "親と範囲が違う");
}

/** 作る物 */
export type NewNode = {
  kind: NodeKind;
  parentId?: string | undefined;
  scope: string;
  title: string;
  body?: string | undefined;
  taskKind?: TaskKind | undefined;
  assignee?: StaffId | undefined;
  priority?: number | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  prNumber?: number | undefined;
  source?: string | undefined;
  issueNumber?: number | undefined;
};

/**
 * 目的、目標、プロジェクト、タスクを 1 つ作り、出来事と監査ログを残す。受け付けのプロジェクトは親を持たずに作れる
 * @param env バインディング
 * @param input 作る物
 * @param actor 誰がいつ
 * @returns 作った行
 * @throws validation_failed タスクでない物に種類、担当、優先度を付けた時、タスクに種類が無い時
 * @throws not_found 親が無い時
 * @throws conflict 親の種類が階層に合わない時、レビューのタスクを作った社員と同じモデルか、作った社員の分からないレビューのタスクを割り振る時
 */
export async function createNode(env: Bindings, input: NewNode, actor: Actor): Promise<NodeRow> {
  const isTask = input.kind === "task";
  if (!isTask && (input.taskKind !== undefined || input.assignee !== undefined || input.priority !== undefined)) {
    throw new AppError("validation_failed", "種類、担当、優先度を持てるのはタスクだけ");
  }
  if (isTask && input.taskKind === undefined) throw new AppError("validation_failed", "タスクには種類が要る");
  if (input.source !== "intake") await checkParent(env.DB, input.kind, input.parentId, input.scope);
  const row: NodeRow = {
    id: newId(clockAt(actor.now)),
    kind: input.kind,
    parentId: input.parentId ?? null,
    scope: input.scope,
    title: input.title,
    body: input.body ?? null,
    taskKind: input.taskKind ?? null,
    assignee: input.assignee ?? null,
    status: "todo",
    priority: input.priority ?? DEFAULT_PRIORITY,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    prNumber: input.prNumber ?? null,
    issueNumber: input.issueNumber ?? null,
    source: input.source ?? null,
    progress: null,
    version: 1,
    createdBy: actor.by,
    createdAt: actor.now,
    updatedAt: actor.now,
  };
  if (row.taskKind === "review" && row.assignee !== null) await checkModels(env.DB, row, row.assignee);
  await drizzle(env.DB).insert(nodes).values(row);
  await appendNodeEvent(env, { nodeId: row.id, staffId: staffOrNull(actor.by), kind: "created", detail: { by: actor.by } }, actor);
  await auditFrom(env, { at: actor.now, actor: actor.by, action: "node.create", target: row.id, scope: row.scope, detail: { kind: row.kind, parentId: row.parentId }, traceId: actor.traceId });
  return row;
}

/**
 * 社員 ID なら返し、オーナーとゲートウェイは null にする
 * @param by 誰
 * @returns 社員 ID か null
 */
function staffOrNull(by: string): string | null {
  return by === "owner" || by === "system" || by === "github" ? null : by;
}

/** 変える物 */
export type NodeChange = {
  parentId?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  assignee?: StaffId | undefined;
  priority?: number | undefined;
  status?: "todo" | "dropped" | undefined;
};

/**
 * 1 件を変え、出来事と監査ログを残す。作業中のタスクの担当と状態は変えない
 * @param env バインディング
 * @param id ID
 * @param version 取得した時点のバージョン
 * @param change 変える物
 * @param actor 誰がいつ
 * @returns 変えた行
 * @throws not_found 無い時、付け替える親が無い時
 * @throws conflict バージョンが違う時、親が階層に合わない時、同じモデルの組の時、作業中のタスクの担当か状態を変える時
 * @throws validation_failed タスクでない物に担当か優先度を付ける時
 */
export async function updateNode(env: Bindings, id: string, version: number, change: NodeChange, actor: Actor): Promise<NodeRow> {
  const row = await findNode(env.DB, id);
  if (row.version !== version) throw new AppError("conflict", "バージョンが違う");
  if (row.kind !== "task" && (change.assignee !== undefined || change.priority !== undefined)) throw new AppError("validation_failed", "担当と優先度を持てるのはタスクだけ");
  if (row.status === "doing" && ((change.assignee !== undefined && change.assignee !== row.assignee) || change.status !== undefined)) {
    throw new AppError("conflict", "作業中のタスクの担当と状態は変えない");
  }
  if (change.parentId !== undefined) await checkParent(env.DB, row.kind, change.parentId, row.scope);
  if (change.assignee !== undefined && row.taskKind === "review") await checkModels(env.DB, row, change.assignee);
  const next: NodeRow = {
    ...row,
    parentId: change.parentId ?? row.parentId,
    title: change.title ?? row.title,
    body: change.body ?? row.body,
    assignee: change.assignee ?? row.assignee,
    priority: change.priority ?? row.priority,
    status: change.status ?? row.status,
    version: row.version + 1,
    updatedAt: actor.now,
  };
  const changed = await saveNode(env.DB, next, row.version);
  if (!changed) throw new AppError("conflict", "バージョンが違う");
  const fields = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
  await appendNodeEvent(env, { nodeId: id, staffId: staffOrNull(actor.by), kind: "updated", detail: fields }, actor);
  await auditFrom(env, { at: actor.now, actor: actor.by, action: "node.update", target: id, scope: row.scope, detail: fields, traceId: actor.traceId });
  return next;
}

/**
 * 行を書き換える。読んだ時のバージョンのままの時だけ書く
 * @param db 今の状態の D1
 * @param row 書く行
 * @param version 読んだ時のバージョン
 * @returns 書けたか
 */
export async function saveNode(db: D1Database, row: NodeRow, version: number): Promise<boolean> {
  const { id, ...rest } = row;
  const done = await drizzle(db)
    .update(nodes)
    .set(rest)
    .where(and(eq(nodes.id, id), eq(nodes.version, version)))
    .returning({ id: nodes.id });
  return done.length > 0;
}

/**
 * 状態を変え、バージョンを 1 つ上げる。読んだ時と状態が変わっていれば書かない
 * @param db 今の状態の D1
 * @param row 読んだ行
 * @param status 新しい状態
 * @param now 今の時刻
 * @param more ほかに変える列
 * @returns 書いた行。書けなければ null
 */
export async function moveNode(db: D1Database, row: NodeRow, status: NodeStatus, now: number, more: Partial<NodeRow> = {}): Promise<NodeRow | null> {
  const next: NodeRow = { ...row, ...more, status, version: row.version + 1, updatedAt: now };
  return (await saveNode(db, next, row.version)) ? next : null;
}

/**
 * 状態を from から to に戻す。読み直してから書くので、間に名前などが直されていても戻せる
 * @param db 今の状態の D1
 * @param id ID
 * @param from 今の状態。違えば何もしない
 * @param to 戻す状態
 * @param now 今の時刻
 * @returns 戻したか
 */
export async function revertNode(db: D1Database, id: string, from: NodeStatus, to: NodeStatus, now: number): Promise<boolean> {
  const row = await findNode(db, id);
  if (row.status !== from) return false;
  return (await moveNode(db, row, to, now)) !== null;
}

/**
 * 作った社員とレビュー担当が別のモデルである事を確かめる
 * @param db 今の状態の D1
 * @param maker 作った社員
 * @param reviewer 確かめる社員
 * @throws conflict 同じモデルの時。どちらかの社員の行が無い時も、同じモデルの組と区別できないので断る
 */
export async function checkPair(db: D1Database, maker: string, reviewer: string): Promise<void> {
  const models = await drizzle(db).select({ id: staff.id, model: staff.model }).from(staff);
  const modelOf = (id: string) => models.find((s) => s.id === id)?.model;
  const a = modelOf(maker);
  const b = modelOf(reviewer);
  if (a === undefined || b === undefined || a === b) throw new AppError("conflict", "作った社員と同じモデルには確かめさせない");
}

/**
 * レビューのタスクから作った社員をたどり、レビュー担当と別のモデルである事を確かめる
 * @param db 今の状態の D1
 * @param review レビューのタスク
 * @param review.repo 確かめるリポジトリ
 * @param review.prNumber 確かめるプルリクエストの番号
 * @param reviewer 割り振る社員
 * @throws conflict リポジトリかプルリクエストの番号が無い時、作った社員が分からない時、作った社員と同じモデルの時
 */
export async function checkModels(db: D1Database, review: Pick<NodeRow, "repo" | "prNumber">, reviewer: string): Promise<void> {
  // 作った社員が分からないと、同じモデルの組か確かめられないので断る
  if (review.repo === null || review.prNumber === null) throw new AppError("conflict", "レビューのタスクに確かめるプルリクエストが無い");
  const [made] = await drizzle(db)
    .select({ assignee: nodes.assignee })
    .from(nodes)
    .where(and(eq(nodes.repo, review.repo), eq(nodes.prNumber, review.prNumber), ne(nodes.taskKind, "review")))
    .limit(1);
  if (!made?.assignee) throw new AppError("conflict", "作った社員が分からない");
  await checkPair(db, made.assignee, reviewer);
}

/**
 * スコープの受け付けのプロジェクトを返す。無ければ作る
 * @param env バインディング
 * @param scope office かサービスの ID
 * @param actor 誰がいつ
 * @returns 受け付けのプロジェクト
 */
export async function intakeProject(env: Bindings, scope: string, actor: Actor): Promise<NodeRow> {
  const [found] = await drizzle(env.DB)
    .select()
    .from(nodes)
    .where(and(eq(nodes.scope, scope), eq(nodes.kind, "project"), eq(nodes.source, "intake")))
    .orderBy(asc(nodes.id))
    .limit(1);
  return found ?? createNode(env, { kind: "project", scope, title: INTAKE_TITLE, source: "intake" }, { ...actor, by: "system" });
}

/**
 * 配下のタスクのうち済んだ割合を、どの 1 件にも出す。見送ったタスクは数えない
 * @param rows 同じ範囲の行
 * @returns ID から進み具合
 */
function progressOf(rows: NodeRow[]): Map<string, number> {
  const children = new Map<string, NodeRow[]>();
  for (const r of rows) if (r.parentId !== null) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const out = new Map<string, number>();
  const count = (r: NodeRow): { done: number; total: number } => {
    if (r.kind === "task") return r.status === "dropped" ? { done: 0, total: 0 } : { done: r.status === "done" ? 1 : 0, total: 1 };
    const sum = { done: 0, total: 0 };
    for (const c of children.get(r.id) ?? []) {
      const n = count(c);
      sum.done += n.done;
      sum.total += n.total;
    }
    out.set(r.id, sum.total === 0 ? 0 : sum.done / sum.total);
    return sum;
  };
  for (const r of rows) {
    if (r.kind === "task") out.set(r.id, r.status === "done" ? 1 : 0);
    else if (!out.has(r.id)) count(r);
  }
  return out;
}

const iso = (at: number) => new Date(at).toISOString();

/**
 * 行を返す形にする
 * @param row nodes の行
 * @param progress 進み具合
 * @returns 木の 1 件
 */
export function toNode(row: NodeRow, progress: number): Node {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parentId,
    scope: row.scope,
    title: row.title,
    body: row.body ?? "",
    taskKind: row.taskKind,
    assignee: row.assignee,
    status: row.status,
    priority: row.priority,
    progress,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * 範囲の行を読む
 * @param db 今の状態の D1
 * @param scope 範囲。無ければすべて
 * @returns 行。作った順
 */
async function scopeRows(db: D1Database, scope: string | undefined): Promise<NodeRow[]> {
  return drizzle(db)
    .select()
    .from(nodes)
    .where(scope === undefined ? undefined : eq(nodes.scope, scope))
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
}

/** 木を読む条件 */
export type TreeQuery = { rootId?: string | undefined; status?: NodeStatus | undefined; scope?: string | undefined; cursor?: string | undefined; limit: number };

/**
 * 木を読む。根は rootId か親の無い物で、ID の順に cursor の後から limit 件。状態で絞るのはタスクだけ
 * @param db 今の状態の D1
 * @param query 条件
 * @returns 根の 1 ページと次のカーソル
 */
export async function loadTrees(db: D1Database, query: TreeQuery): Promise<{ trees: NodeTree[]; next: string | null }> {
  const rows = await scopeRows(db, query.scope);
  const progress = progressOf(rows);
  const children = new Map<string, NodeRow[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) if (r.parentId !== null && ids.has(r.parentId)) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const build = (r: NodeRow): NodeTree => ({
    ...toNode(r, progress.get(r.id) ?? 0),
    children: (children.get(r.id) ?? []).filter((c) => c.kind !== "task" || query.status === undefined || c.status === query.status).map(build),
  });
  const roots = rows
    .filter((r) => (query.rootId === undefined ? r.parentId === null || !ids.has(r.parentId) : r.id === query.rootId))
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .filter((r) => query.cursor === undefined || r.id > query.cursor);
  const page = roots.slice(0, query.limit);
  return { trees: page.map(build), next: roots.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

/**
 * 1 件と、目的からすぐ上の親まで、出来事を読む
 * @param env バインディング
 * @param id ID
 * @returns 1 件、親の並び、出来事
 * @throws not_found 無い時
 */
export async function loadDetail(env: Bindings, id: string): Promise<{ node: Node; ancestors: Node[]; events: NodeEvent[] }> {
  const row = await findNode(env.DB, id);
  const rows = await scopeRows(env.DB, row.scope);
  const progress = progressOf(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ancestors: Node[] = [];
  // 親の鎖は 4 段まで。壊れた行で回り続けないよう段の数で止める
  for (let parent = row.parentId === null ? undefined : byId.get(row.parentId), n = 0; parent && n < 4; parent = parent.parentId === null ? undefined : byId.get(parent.parentId), n += 1) {
    ancestors.unshift(toNode(parent, progress.get(parent.id) ?? 0));
  }
  const events: NodeEvent[] = [];
  for (const name of RECORD_BINDINGS) {
    const db = env[name];
    if (!db) continue;
    // 同じミリ秒の出来事は ID では順が決まらないので、足した順 (rowid) で並べる
    const found = await drizzle(db).select().from(nodeEvents).where(eq(nodeEvents.nodeId, id)).orderBy(asc(nodeEvents.at), sql`rowid`);
    for (const e of found) {
      // D1 の JSON は形を確かめてから返す
      const detail = Detail.safeParse(e.detail);
      events.push({ at: iso(e.at), staffId: e.staffId, kind: e.kind, detail: detail.success ? detail.data : {} });
    }
  }
  return { node: toNode(row, progress.get(row.id) ?? 0), ancestors, events };
}
