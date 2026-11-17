// 運用の段階のサービスの、見つけて直す仕組みの Issue を、運用の親の子にして、設計書の子と同じ形で回す (開発の回し方の 3.7)
import { AppError, devIssueKey, devIssueText, SERVICE_NAME } from "@know-office/core";
import { and, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { devIssueKeyOf, publicDevIssues } from "../findings/tracker.ts";
import type { DevIssue, DevIssues } from "./dev-issues.ts";
import { loadDocsRepo } from "./docs-setting.ts";
import { claim, type Ctx, materialize, type Row, type Spec } from "./plan.ts";
import { OPERATIONS, reopenParent } from "./release.ts";

/** 運用の子の Issue になる、見つけた原因 */
export type OpsFinding = {
  /** 原因の指紋 */
  fingerprint: string;
  /** error、slow、cost */
  kind: "error" | "slow" | "cost";
  /** Issue の題と本文。本文の終わりに指紋の印がある */
  title: string;
  body: string;
};

/** 運用の親の題と本文 */
const PARENT_TEXT = devIssueText({ feature: OPERATIONS, featureName: "運用", requirement: null });

/**
 * 見つけた原因の Issue を、運用の親の子として作る。順は、親の行を取って作り切る、子の行を取る (pending)、GitHub に子を作る (印で探してから)、行を open にして開発担当のタスクを足す。落ちた所からは次の回が続ける
 * @param env バインディング
 * @param issues GitHub の口
 * @param repo 原因が起きたサービスのリポジトリ。大文字小文字は問わない
 * @param finding 原因
 * @param now 今の時刻
 * @returns 子の Issue の番号。運用の段階のサービスでなければ null
 * @throws conflict 別の呼び出しが親か子を作っている時。呼んだ側は印を外して次の回に回す
 * @throws upstream_failed GitHub を読めない時、書けない時
 */
export async function opsIssue(env: Bindings, issues: DevIssues, repo: string, finding: OpsFinding, now: number): Promise<number | null> {
  const orm = drizzle(env.DB);
  const [service] = await orm.select().from(services).where(and(sql`lower(${services.repo}) = lower(${repo})`, inArray(services.stage, ["service", "operation"]))).limit(1);
  if (service?.repo === undefined || service.repo === null) return null;
  const name = (service.repo.split("/")[1] ?? "").toLowerCase();
  if (!SERVICE_NAME.test(name)) return null;
  const docsRepo = await loadDocsRepo(env.DB);
  const pub = publicDevIssues(issues);
  const listed = await pub.listIssues(service.repo);
  const byKey = new Map<string, DevIssue>();
  for (const issue of listed) {
    const key = devIssueKeyOf(issue.body);
    if (key !== null) byKey.set(key, issue);
  }
  const ctx: Ctx = { env, issues: pub, actor: { by: "system", now }, service: { id: service.id, repo: service.repo }, docs: `${docsRepo?.repo ?? service.repo}/services/${name}`, byKey, byNumber: new Map(listed.map((i) => [i.number, i])) };

  const parentSpec: Spec = { kind: "parent", feature: OPERATIONS, requirement: null, hash: null, issueKind: null, paths: null, high: false, ...PARENT_TEXT, key: await devIssueKey({ serviceId: service.id, kind: "parent", feature: OPERATIONS, requirement: null, hash: null }) };
  const got = await claim(env, ctx.service, parentSpec, now);
  // 親は子より先に作り切る。取れなければ子を作らずに断り、次の回に回す
  let parent: Row = got.owned ? await materialize(ctx, got.row, parentSpec, null) : got.row;
  if (parent.number === null) throw new AppError("conflict", "運用の親がまだ作り切れていない");

  const requirement = `原因 ${finding.fingerprint.slice(0, 12)}`;
  const childSpec: Spec = {
    kind: "child",
    feature: OPERATIONS,
    requirement,
    hash: finding.fingerprint,
    issueKind: finding.kind === "error" ? "bug" : "chore",
    // 触るファイルは決まらないので、行の heads は空の頭 1 つにして、同じリポジトリのほかの子と重ねる (運用の子が回る間はほかの子が止まる)
    paths: null,
    high: false,
    title: finding.title,
    body: finding.body,
    key: await devIssueKey({ serviceId: service.id, kind: "child", feature: OPERATIONS, requirement, hash: finding.fingerprint }),
  };
  const mine = await claim(env, ctx.service, childSpec, now);
  if (!mine.owned) return mine.row.number;
  if (await reopenParent(env, pub, parent)) parent = { ...parent, state: "open", closedAt: null, closeReason: null };
  const done = await materialize(ctx, mine.row, childSpec, { number: parent.number ?? 0, id: parent.issueId ?? 0 });
  return done.number;
}
