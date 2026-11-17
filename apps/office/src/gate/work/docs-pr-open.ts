// 開発担当のツール docs_pr_open の中身と、コードの PR に結ぶ設計書の PR の確かめ。同じ時に直す設計書は、サービスのタスクが設計書のリポジトリへ PR を出す (開発の回し方の 3.6)
import { AppError, type DocsPrOpenTool } from "@know-office/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services } from "../db/main.ts";
import { assertDocsPr, docsNameOf } from "../devloop/docs-pr.ts";
import { claimDocs, type DocsRow, docsOf, dropClaim, replaceDocsBranch, setDocsPr } from "../devloop/docs-link.ts";
import { loadDocsRepo } from "../devloop/docs-setting.ts";
import type { Bindings } from "../env.ts";
import { auditFrom } from "../ledger/record.ts";
import type { Forge } from "./loop.ts";
import { appendNodeEvent, type NodeRow } from "./nodes.ts";
import { repoRefusal } from "./review.ts";
import { denyByRule, type PrCall } from "./rule-denied.ts";

/**
 * 設計書の PR のブランチの先を固定して、ルールと形と置き場を確かめる。変えたファイルは 1 回だけ読み、ルールと形の両方に使う
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task タスク
 * @param row 設計書の PR の行
 * @returns 固定したブランチの先
 * @throws rule_denied ルールの外の時
 * @throws validation_failed 設計書の形が違う時、そのサービスの置き場の外を変える時
 * @throws upstream_failed 読めない時
 */
export async function guardDocsBranch(env: Bindings, forge: Forge, call: PrCall, task: NodeRow, row: Pick<DocsRow, "repo" | "branch">): Promise<string> {
  const head = await forge.branchHead(row.repo, row.branch);
  const paths = await forge.changedPaths(row.repo, head);
  const refusal = await repoRefusal(env, forge, { action: "pull_request", repo: row.repo, branch: head, ...(paths === null ? {} : { paths }) });
  if (refusal !== null) return denyByRule(env, call, task, refusal, row.repo);
  // 変えた道が分からない (切れた) 時は、形の確かめが断る
  await assertDocsPr(env.DB, forge, { repo: row.repo, scope: task.scope, source: null }, head, await docsNameOf(env.DB, task.scope), paths);
  return head;
}

/**
 * 出す前の確かめを通し、PR を出して行に番号を書く。同じブランチの開いた PR が既にあれば、出さずにそれを使う。出す前に断った時は取った行を消す
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task タスク
 * @param row 取った行
 * @param input docs_pr_open の入力
 * @returns PR の番号
 * @throws 確かめの通り
 */
async function publish(env: Bindings, forge: Forge, call: PrCall, task: NodeRow, row: DocsRow, input: DocsPrOpenTool): Promise<number> {
  try {
    await guardDocsBranch(env, forge, call, task, row);
  } catch (error) {
    await dropClaim(env.DB, task.id);
    throw error;
  }
  // 出した後に落ちても行は残る。次の呼びは、このブランチの開いた PR を先に読んで使う
  const pull = (await forge.pullOf(row.repo, row.branch)) ?? (await forge.openPull({ repo: row.repo, branch: row.branch, title: input.title, body: input.body }));
  await setDocsPr(env.DB, task.id, pull.number);
  const actor = { by: call.staffId, now: call.now, traceId: call.traceId };
  await appendNodeEvent(env, { nodeId: task.id, staffId: call.staffId, kind: "docs_pr_opened", detail: { prNumber: pull.number, branch: row.branch } }, actor);
  await auditFrom(env, { at: call.now, actor: call.staffId, action: "pull_request.open", target: task.id, scope: task.scope, detail: { repo: row.repo, prNumber: pull.number, docs: true }, traceId: call.traceId });
  return pull.number;
}

/**
 * 開発担当が同じタスクで、設計書のリポジトリに PR を出す。タスクは作業中のまま。同じサービスの設計書を直す別のタスクがある間は 409
 * 2 度目は新しい PR を出さず、確かめ直して同じ番号を返す。行の PR が main に入っていれば、新しいブランチで出し直して行を替える
 * @param env バインディング
 * @param forge GitHub
 * @param call 呼んだ社員と時刻
 * @param task 今のタスク
 * @param input DocsPrOpenTool
 * @returns PR の番号とブランチ
 * @throws conflict 作業中のこの社員のタスクでない時、サービスのタスクでない時、設計書のリポジトリが無い時、重なる設計書のタスクがある時
 * @throws validation_failed main に入った PR と同じブランチの名前の時、設計書の形が違う時
 * @throws rule_denied ルールの外の時
 * @throws upstream_failed GitHub から読めない時
 */
export async function openDocsPr(env: Bindings, forge: Forge, call: PrCall, task: NodeRow, input: DocsPrOpenTool): Promise<{ number: number; branch: string }> {
  if (task.repo === null || task.status !== "doing" || task.assignee !== call.staffId) throw new AppError("conflict", "作業中のタスクが無い");
  if (task.source?.startsWith("design:") === true) throw new AppError("conflict", "設計書を書くタスクは pr_open で出す");
  const [service] = await drizzle(env.DB).select({ id: services.id }).from(services).where(and(eq(services.id, task.scope), eq(services.repo, task.repo))).limit(1);
  if (!service) throw new AppError("conflict", "サービスのタスクでない");
  const docs = await loadDocsRepo(env.DB);
  if (docs === null || docs.repo.toLowerCase() === task.repo.toLowerCase()) throw new AppError("conflict", "設計書のリポジトリを設定で選んでいない");
  const branch = `ko/${task.id.slice(0, 8)}-${input.name}`;
  let row = await docsOf(env.DB, task.id);
  if (row?.prNumber != null) {
    // 出した PR が main に入っていれば、新しいブランチで出し直す。入っていなければ新しい PR は出さず、確かめ直す
    if (await forge.inMain(row.repo, await forge.branchHead(row.repo, row.branch))) {
      if (branch === row.branch) throw new AppError("validation_failed", "出した設計書の PR はもう main に入った。別の name で出し直す", { errors: [{ pointer: "#/name", detail: "新しいブランチの名前にする" }] });
      if (!(await replaceDocsBranch(env.DB, row, branch))) throw new AppError("conflict", "設計書の PR の行が変わった");
      row = { ...row, prNumber: null, branch };
    } else {
      await guardDocsBranch(env, forge, call, task, row);
      return { number: row.prNumber, branch: row.branch };
    }
  } else if (row === null) {
    if (!(await claimDocs(env.DB, { nodeId: task.id, serviceId: task.scope, repo: docs.repo, branch, now: call.now }))) throw new AppError("conflict", "同じサービスの設計書を直す別のタスクが終わるまで待つ");
    row = await docsOf(env.DB, task.id);
  }
  if (row === null) throw new AppError("conflict", "設計書の PR の行が無い");
  return { number: await publish(env, forge, call, task, row, input), branch: row.branch };
}
