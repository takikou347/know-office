// サービスの Issue の木を読む。親、子、同じ番号の開発担当のタスク、設計書の PR、サービスに進められるか (開発の回し方の 3.7)
import type { ServiceIssues } from "@know-office/core";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { devIssues, nodes, taskDocs } from "../db/main.ts";
import { isReady, OPERATIONS } from "../devloop/release.ts";
import type { Bindings } from "../env.ts";
import { findService } from "./flow.ts";

/**
 * 1 回に返す子の数の上限。画面は 1 画面で見せるので、これを超えるサービスは番号の若い方から 500 件までを返し、残りは返さない (木のページ分けは作らない)
 * 子は閉じた物も残るので、運用の子が積み重なるサービスで返事が際限なく大きくならないようにする
 */
export const ISSUE_CHILDREN_MAX = 500;

/**
 * サービスの Issue の木を読む。設計書より前の段階でも空の木を返す
 * @param env バインディング
 * @param serviceId サービス ID
 * @returns 親と子の木、設計書の PR、サービスに進められるか
 * @throws not_found サービスが無い時
 */
export async function loadServiceIssues(env: Bindings, serviceId: string): Promise<ServiceIssues> {
  await findService(env.DB, serviceId);
  const orm = drizzle(env.DB);
  const mine = eq(devIssues.serviceId, serviceId);
  const [parents, children, design, together, ready] = await Promise.all([
    orm.select().from(devIssues).where(and(mine, eq(devIssues.kind, "parent"), isNotNull(devIssues.number))).orderBy(asc(devIssues.number)),
    orm.select().from(devIssues).where(and(mine, eq(devIssues.kind, "child"), isNotNull(devIssues.number))).orderBy(asc(devIssues.number)).limit(ISSUE_CHILDREN_MAX),
    orm.select({ repo: nodes.repo, number: nodes.prNumber, id: nodes.id, status: nodes.status }).from(nodes).where(and(eq(nodes.source, `design:${serviceId}`), isNotNull(nodes.prNumber))),
    orm.select({ repo: taskDocs.repo, number: taskDocs.prNumber, id: nodes.id, status: nodes.status }).from(taskDocs).innerJoin(nodes, eq(nodes.id, taskDocs.nodeId)).where(and(eq(taskDocs.serviceId, serviceId), isNotNull(taskDocs.prNumber))),
    isReady(env.DB, serviceId),
  ]);
  const numbers = children.flatMap((c) => (c.number === null ? [] : [`issue:${String(c.number)}`]));
  // D1 は 1 文に束ねる値を 100 までしか取らないので、90 件ずつ別の文で読む
  const parts = await Promise.all(chunk(numbers).map((part) => orm.select({ id: nodes.id, status: nodes.status, prNumber: nodes.prNumber, source: nodes.source }).from(nodes).where(and(eq(nodes.scope, serviceId), inArray(nodes.source, part)))));
  const tasks = parts.flat();
  const taskOf = new Map(tasks.map((t) => [t.source, t]));
  return {
    ready,
    docsPrs: [
      ...design.flatMap((p) => (p.number === null || p.repo === null ? [] : [{ repo: p.repo, number: p.number, kind: "design" as const, task: { id: p.id, status: p.status } }])),
      ...together.flatMap((p) => (p.number === null ? [] : [{ repo: p.repo, number: p.number, kind: "together" as const, task: { id: p.id, status: p.status } }])),
    ],
    parents: parents.map((p) => ({
      number: p.number ?? 0,
      feature: p.feature,
      state: p.state === "closed" ? "closed" : "open",
      operations: p.feature === OPERATIONS,
      children: children
        .filter((c) => c.parentNumber === p.number)
        .map((c) => {
          const task = taskOf.get(`issue:${String(c.number)}`);
          return { number: c.number ?? 0, requirement: c.requirement, kind: c.issueKind, state: c.state === "closed" ? ("closed" as const) : ("open" as const), task: task === undefined ? null : { id: task.id, status: task.status, prNumber: task.prNumber } };
        }),
    })),
  };
}

/**
 * D1 の束ねる値の上限 (100) に収めるため、100 件ずつに分ける
 * @param values 値
 * @returns 100 件までの束
 */
function chunk(values: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < values.length; i += 90) out.push(values.slice(i, i + 90));
  return out;
}
