// 設計書の PR を結んだタスクを main に入れる所。設計書の側の条件を見て、設計書を先に、コードを後に進め、入れた要件の本文に子 Issue のハッシュを合わせる (開発の回し方の 3.6)
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError, devIssueKey, docsMergeNeeds, missingConditions, parseRequirements } from "@know-office/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { devIssues } from "../db/main.ts";
import { docsOf } from "../devloop/docs-link.ts";
import { docsNameOf, isFirstDocs, verifyDocsPr } from "../devloop/docs-pr.ts";
import { loadDocsRepo } from "../devloop/docs-setting.ts";
import type { Bindings } from "../env.ts";
import type { Forge } from "./loop.ts";

/** 結んだ設計書の PR。sha は承認の時に確かめた先。landed は、その先がもう main に入っている (分かれた後の押し直しなど) 印で、進めるのはコードだけ */
export type DocsTarget = { repo: string; branch: string; sha: string; landed?: boolean };

/** 結んだ設計書の側の答え。none は結んでいない。ready の docs.landed は、確かめた先がもう main に入っている */
export type Linked = { kind: "none" } | { kind: "ready"; docs: DocsTarget } | { kind: "refused" | "waiting" | "failed"; reason: string };

/** 設計書のリポジトリへの merge を断るかを、ルールと照らす口。変わったファイルも返す */
export type DocsRuleCheck = (repo: string, sha: string) => Promise<{ refusal: { reason: string } | null; paths: readonly string[] }>;

/**
 * 結んだ設計書の PR が main に入れられるかを決める。リポジトリが今の設計書のリポジトリと同じで、承認の時に確かめた先があり、ルール、形、チェックとレビュー担当の承認 (最初の設計書はオーナーも) がそろう時だけ ready
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param reviewed レビューで確かめた設計書の先。無ければ null
 * @param approvals レビュー担当とオーナーの承認
 * @param approvals.reviewer レビュー担当が承認しているか
 * @param approvals.owner オーナーが承認しているか
 * @param check 設計書のリポジトリへの merge をルールと照らす口
 * @returns 設計書の側の答え
 * @throws upstream_failed GitHub から読めない時
 */
export async function linkedGate(env: Bindings, forge: Forge, made: { id: string; scope: string }, reviewed: string | null, approvals: { reviewer: boolean; owner: boolean }, check: DocsRuleCheck): Promise<Linked> {
  const row = await docsOf(env.DB, made.id);
  if (row === null) return { kind: "none" };
  const current = await loadDocsRepo(env.DB);
  if (current === null || current.repo.toLowerCase() !== row.repo.toLowerCase()) return { kind: "refused", reason: "設計書のリポジトリが変わった" };
  if (reviewed === null || row.prNumber === null) return { kind: "refused", reason: "確かめた設計書の先が分からない" };
  // 先に main に入っていれば (分かれた後の押し直し) 設計書は進めず、コードだけ進める。要件のハッシュは合わせる
  if (await forge.inMain(row.repo, reviewed)) return { kind: "ready", docs: { repo: row.repo, branch: row.branch, sha: reviewed, landed: true } };
  const checked = await check(row.repo, reviewed);
  if (checked.refusal !== null) return { kind: "refused", reason: checked.refusal.reason };
  const shape = await verifyDocsPr(forge, row.repo, reviewed, checked.paths, await docsNameOf(env.DB, made.scope));
  if (shape.kind === "refused") return { kind: "refused", reason: shape.reason };
  // 断る、落ちた、待つの順に答える。チェックが落ちていれば、承認を待っていても落ちたと答える
  const checks = await forge.checkState(row.repo, reviewed);
  if (checks === "failed") return { kind: "failed", reason: "docs_checks" };
  if (shape.kind === "waiting") return { kind: "waiting", reason: shape.reason };
  const when = docsMergeNeeds(await isFirstDocs(forge, row.repo, shape.name));
  const others = missingConditions(when, { checks: true, ...approvals });
  if (others.length > 0) return { kind: "waiting", reason: others.join(",") };
  if (checks !== "passed") return { kind: "waiting", reason: "docs_checks" };
  return { kind: "ready", docs: { repo: row.repo, branch: row.branch, sha: reviewed } };
}

/** 2 つの PR を進めた結果。behind は何も進めずに、遅れたリポジトリを持つ。split は設計書だけが入った事で、split は作った社員のタスクを戻す先、code は失敗の種類、error は投げられた物 (遅れただけなら無い) */
export type Landed = "merged" | { behind: string } | { split: "todo" | "review"; code: string; error?: unknown };

/**
 * 設計書を先に、コードを後に main へ進める。進める前にコードが fast-forward で進められるかを見て、進められなければ何も進めずに behind を返す
 * 設計書の更新が behind でも何も進んでいないので behind。設計書を進めた後にコードが進められなければ、設計書は戻さず split を返す (behind は作った社員が rebase するので todo、ほかの失敗は review で、失敗の種類と投げられた物を持つ)
 * @param forge GitHub
 * @param code コードの側。リポジトリ、ブランチ、確かめたコミット
 * @param code.repo リポジトリ
 * @param code.branch ブランチ
 * @param code.sha 確かめたコミット
 * @param docs 設計書の側
 * @returns 結果
 * @throws upstream_failed 設計書を進める更新が behind 以外で断られた時 (何も進んでいない)
 */
export async function landBoth(forge: Forge, code: { repo: string; branch: string; sha: string }, docs: DocsTarget): Promise<Landed> {
  if (!(await forge.fastForwardable(code.repo, code.sha))) return { behind: code.repo };
  if ((await forge.merge(docs.repo, { branch: docs.branch, sha: docs.sha })) === "behind") return { behind: docs.repo };
  try {
    return (await forge.merge(code.repo, { branch: code.branch, sha: code.sha })) === "behind" ? { split: "todo", code: "behind" } : "merged";
  } catch (error) {
    return { split: "review", code: error instanceof AppError ? error.code : "internal", error };
  }
}

/** 子 Issue の要件のハッシュを、入れた設計書に合わせる文と、戻す文 */
export type Rehash = { apply: D1PreparedStatement; revert: D1PreparedStatement };

/**
 * 子 Issue のタスクのコードを入れる時に、子の dev_issues の要件のハッシュと印の鍵を、入れる設計書の要件のハッシュに直す文を作る。合わせ直しで子を作り直さないため。同じ機能と要件で新しいハッシュの子がもう居れば、重ならないよう直さない
 * @param db 今の状態の D1
 * @param forge GitHub
 * @param made 確かめたタスクの ID、版、リポジトリ、Issue の番号、範囲。直す文は、このタスクが版の 1 つ先で done になっている時だけ書く (done にする文に負けた側は書かない)
 * @param made.id タスク ID
 * @param made.version 読んだ時の版
 * @param made.repo リポジトリ
 * @param made.issueNumber Issue の番号
 * @param made.scope サービス ID
 * @param docs 入れる設計書
 * @returns 直す文と戻す文。直す所が無ければ null
 * @throws upstream_failed 設計書を読めない時
 */
export async function rehashFor(db: D1Database, forge: Forge, made: { id: string; version: number; repo: string | null; issueNumber: number | null; scope: string }, docs: DocsTarget): Promise<Rehash | null> {
  if (made.repo === null || made.issueNumber === null) return null;
  const [row] = await drizzle(db).select().from(devIssues).where(and(eq(devIssues.repo, made.repo), eq(devIssues.number, made.issueNumber), eq(devIssues.kind, "child"), eq(devIssues.state, "open"))).limit(1);
  if (!row || row.requirement === null) return null;
  const text = await forge.readFile(docs.repo, docs.sha, `services/${await docsNameOf(db, made.scope)}/docs/04-detail/${row.feature}.md`);
  if (text === null) return null;
  const next = (await parseRequirements(text)).find((r) => r.name === row.requirement);
  if (next === undefined || next.hash === row.reqHash) return null;
  const key = await devIssueKey({ serviceId: row.serviceId, kind: "child", feature: row.feature, requirement: row.requirement, hash: next.hash });
  const apply = db
    .prepare(
      "UPDATE dev_issues SET req_hash = ?1, mark_key = ?2 WHERE id = ?3 AND req_hash IS ?4 AND NOT EXISTS (SELECT 1 FROM dev_issues x WHERE x.service_id = ?5 AND x.kind = 'child' AND x.feature = ?6 AND x.requirement = ?7 AND x.req_hash = ?1) AND EXISTS (SELECT 1 FROM nodes WHERE id = ?8 AND version = ?9 AND status = 'done')",
    )
    .bind(next.hash, key, row.id, row.reqHash, row.serviceId, row.feature, row.requirement, made.id, made.version + 1);
  const revert = db.prepare("UPDATE dev_issues SET req_hash = ?1, mark_key = ?2 WHERE id = ?3 AND req_hash = ?4").bind(row.reqHash, row.markKey, row.id, next.hash);
  return { apply, revert };
}
