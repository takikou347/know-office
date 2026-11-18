// 親 Issue を閉じ、試作のサービスの機能の親がすべて閉じたらオーナーにサービスに進められると知らせる。子が閉じた所 (main に入った時と、設計書から消えた時) から呼び、5 分ごとの見直しが閉じ残しを拾う (開発の回し方の 3.7)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, newId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { announceNotice } from "../live/publish.ts";
import { clockAt } from "../work/attendance.ts";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { devIssues } from "../db/main.ts";
import type { DevIssues } from "./dev-issues.ts";

/** 運用の親の機能の名前。見つけて直す仕組みが作った Issue をまとめる親で、サービスごとに 1 つ */
export const OPERATIONS = "operations";

/** 1 回の見直しで閉じる親の数の上限。残りは次の 5 分に回す */
export const SETTLE_LIMIT = 20;

/**
 * サービスに進められる条件の SQL。機能の親 (運用の親と、子が 0 件の親を除く) がすべて閉じていて、入れて閉じた親 (理由が completed か、前に閉じて理由が無い物) が 1 つ以上ある。通知と API の ready が同じ条件を使う
 * @param service サービス ID を束ねたプレースホルダ (?1 など)
 * @returns SQL の条件
 */
export function readySql(service: string): string {
  const feature = `p.service_id = ${service} AND p.kind = 'parent' AND p.feature <> '${OPERATIONS}'`;
  const hasChild = "EXISTS (SELECT 1 FROM dev_issues c WHERE c.service_id = p.service_id AND c.kind = 'child' AND c.feature = p.feature)";
  return `(NOT EXISTS (SELECT 1 FROM dev_issues p WHERE ${feature} AND p.state <> 'closed' AND ${hasChild}) AND EXISTS (SELECT 1 FROM dev_issues p WHERE ${feature} AND p.state = 'closed' AND p.close_reason IS NOT 'not_planned'))`;
}

/**
 * サービスに進められる条件が今そろっているかを読む
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns そろっていれば true
 */
export async function isReady(db: D1Database, serviceId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${readySql("?1")} AS ready`).bind(serviceId).first<{ ready: number }>();
  return row?.ready === 1;
}

/** 閉じる親の行 */
type ParentRow = { id: string; service_id: string; repo: string; number: number };

/**
 * 親の子の数と、開いている子の数と、入れて閉じた子の数を読む
 * @param db 今の状態の D1
 * @param parent 親
 * @returns 子の数、閉じていない子の数、入れて閉じた子の数
 */
async function childrenOf(db: D1Database, parent: ParentRow): Promise<{ total: number; notClosed: number; completed: number }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(state <> 'closed'), 0) AS notClosed, COALESCE(SUM(state = 'closed' AND close_reason IS NOT 'not_planned'), 0) AS completed FROM dev_issues WHERE service_id = ? AND kind = 'child' AND feature = (SELECT feature FROM dev_issues WHERE id = ?)")
    .bind(parent.service_id, parent.id)
    .first<{ total: number; notClosed: number; completed: number }>();
  return row ?? { total: 0, notClosed: 0, completed: 0 };
}

/**
 * 子がすべて閉じた開いた親を閉じる。D1 で子がすべて閉じている事を確かめてから GitHub を閉じ、行を閉じる文と通知を足す文は同じバッチで書く。閉じる文が取れなかった時 (閉じる間に子が足されて親が開き直された時) は、閉じた GitHub の親を開き直す
 * 閉じる理由は、子に入れて閉じた物が 1 つでもあれば completed、全部が設計書から消えて閉じた物なら not_planned。通知は、閉じた親が機能の親で、サービスが試作で、サービスに進められる条件 (readySql) がそろい、同じ未読の通知が無い時だけ足す
 * @param env バインディング
 * @param issues GitHub の Issue
 * @param parent 親の行
 * @param now 今の時刻
 * @throws upstream_failed GitHub が閉じられなかった時 (行は開いたまま)
 */
async function closeParent(env: Bindings, issues: DevIssues, parent: ParentRow, now: number): Promise<void> {
  const kids = await childrenOf(env.DB, parent);
  if (kids.total === 0 || kids.notClosed > 0) return;
  const reason = kids.completed > 0 ? "completed" : "not_planned";
  await issues.close(parent.repo, parent.number, reason);
  const noticeId = newId(clockAt(now));
  const noChildOpen = "NOT EXISTS (SELECT 1 FROM dev_issues c WHERE c.service_id = ?3 AND c.kind = 'child' AND c.feature = (SELECT feature FROM dev_issues WHERE id = ?5) AND c.state <> 'closed')";
  const [closed, notice] = await env.DB.batch([
    env.DB.prepare(`UPDATE dev_issues SET state = 'closed', closed_at = ?1, close_reason = ?2 WHERE id = ?5 AND state = 'open' AND ${noChildOpen}`).bind(now, reason, parent.service_id, parent.number, parent.id),
    env.DB.prepare(
      `INSERT INTO notices (id, at, level, kind, title, body, scope, link)
       SELECT ?1, ?2, 'info', 'service_ready', s.name || ' をサービスに進められる', '機能の親 Issue がすべて閉じた。段階を移すのはオーナー', s.id, '/services/' || s.id FROM services s
       WHERE s.id = ?3 AND s.stage = 'prototype' AND changes() > 0 AND (SELECT feature FROM dev_issues WHERE id = ?4) <> '${OPERATIONS}' AND ${readySql("?3")}
         AND NOT EXISTS (SELECT 1 FROM notices WHERE kind = 'service_ready' AND scope = ?3 AND read_at IS NULL)`,
    ).bind(noticeId, now, parent.service_id, parent.id),
  ]);
  if ((closed?.meta.changes ?? 0) === 0) {
    // 閉じる文が取れなかった。別の呼びが閉じていれば何もせず、まだ開いていれば (子が足されて開き直された) GitHub の親を開き直す
    const now1 = await env.DB.prepare("SELECT state FROM dev_issues WHERE id = ?").bind(parent.id).first<{ state: string }>();
    if (now1?.state === "open") await issues.reopen(parent.repo, parent.number);
    return;
  }
  if ((notice?.meta.changes ?? 0) > 0) await announceNotice(env, noticeId, clockAt(now));
}

/**
 * 子が閉じた後に、その親を閉じられれば閉じる。子がもう閉じていた時 (送り直し) も呼んでよく、何度呼んでも同じ
 * @param env バインディング
 * @param issues GitHub の Issue
 * @param repo サービスのリポジトリ
 * @param childNumber 閉じた子の番号
 * @param now 今の時刻
 * @throws upstream_failed GitHub が閉じられなかった時
 */
export async function settleParent(env: Bindings, issues: DevIssues, repo: string, childNumber: number, now: number): Promise<void> {
  const parent = await env.DB.prepare(
    "SELECT p.id, p.service_id, p.repo, p.number FROM dev_issues c JOIN dev_issues p ON p.service_id = c.service_id AND p.kind = 'parent' AND p.number = c.parent_number AND p.state = 'open' WHERE c.repo = ? AND c.number = ? AND c.kind = 'child'",
  )
    .bind(repo, childNumber)
    .first<ParentRow>();
  if (parent !== null) await closeParent(env, issues, parent, now);
}

/**
 * 子がすべて閉じたのに開いたままの親を閉じる。子を閉じた後、親を閉じる前に落ちた時の見直しで、5 分ごとに呼ぶ。1 回に SETTLE_LIMIT 件まで。1 件の失敗で残りを止めない
 * @param env バインディング
 * @param issues GitHub の Issue
 * @param now 今の時刻
 * @returns 閉じられなかった親の数
 */
export async function settleReleases(env: Bindings, issues: DevIssues, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.service_id, p.repo, p.number FROM dev_issues p
     WHERE p.kind = 'parent' AND p.state = 'open' AND p.number IS NOT NULL
       AND EXISTS (SELECT 1 FROM dev_issues c WHERE c.service_id = p.service_id AND c.kind = 'child' AND c.feature = p.feature)
       AND NOT EXISTS (SELECT 1 FROM dev_issues c WHERE c.service_id = p.service_id AND c.kind = 'child' AND c.feature = p.feature AND c.state <> 'closed')
     ORDER BY p.id LIMIT ?`,
  )
    .bind(SETTLE_LIMIT)
    .all<ParentRow>();
  let failed = 0;
  for (const parent of results) {
    try {
      await closeParent(env, issues, parent, now);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      failed += 1;
    }
  }
  return failed;
}

/**
 * 閉じた親に新しい子が付く時に、親を開き直す。行を開く文は 1 文の条件付きで、書けた時だけ GitHub を開き直す (親を閉じる側も同じ行を条件にするので、どちらかだけが GitHub を動かす)。GitHub が断ったら行を閉じに戻す
 * @param env バインディング
 * @param issues GitHub の口
 * @param parent 親の行 (閉じていて、番号がある物)
 * @returns 開き直した時は true
 * @throws upstream_failed GitHub が開き直しを断った時
 */
export async function reopenParent(env: Bindings, issues: DevIssues, parent: typeof devIssues.$inferSelect): Promise<boolean> {
  if (parent.number === null) return false;
  const orm = drizzle(env.DB);
  const [wrote] = await orm.update(devIssues).set({ state: "open", closedAt: null, closeReason: null }).where(and(eq(devIssues.id, parent.id), eq(devIssues.state, "closed"))).returning({ id: devIssues.id });
  if (wrote === undefined) return false;
  try {
    await issues.reopen(parent.repo, parent.number);
  } catch (error) {
    await orm.update(devIssues).set({ state: "closed", closedAt: parent.closedAt, closeReason: parent.closeReason }).where(and(eq(devIssues.id, parent.id), eq(devIssues.state, "open")));
    throw error;
  }
  return true;
}
