// 子 Issue のタスクの PR の決まり。本文にゲートウェイが Closes を付け、bug と feature は変えたファイルにテストのファイルが無ければ断る (開発の回し方の 3.5)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, hasTestFile, type IssueKind } from "@know-office/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { devIssues } from "../db/main.ts";
import type { ChangedFile, Forge } from "../work/loop.ts";

/** タスクが持つ子 Issue。番号と種類 */
export type ChildRef = { number: number; issueKind: IssueKind | null };

/** compare で読んだ変えたファイル。paths は動かしたファイルの前の道も入れる。truncated は GitHub が 300 件で切った時 */
export type PrFiles = { files: ChangedFile[]; paths: string[]; truncated: boolean };

/**
 * タスクが子 Issue のタスクなら、その子を読む。設計書のタスク、社長の分けるタスク、別のリポジトリの同じ番号は子ではない
 * @param db 今の状態の D1
 * @param task リポジトリと Issue の番号
 * @param task.repo リポジトリ
 * @param task.issueNumber Issue の番号
 * @returns 子。持たなければ null
 */
export async function childOf(db: D1Database, task: { repo: string | null; issueNumber: number | null }): Promise<ChildRef | null> {
  if (task.repo === null || task.issueNumber === null) return null;
  const [row] = await drizzle(db)
    .select({ number: devIssues.number, issueKind: devIssues.issueKind })
    .from(devIssues)
    .where(and(eq(devIssues.repo, task.repo), eq(devIssues.number, task.issueNumber), eq(devIssues.kind, "child")))
    .limit(1);
  return row?.number === undefined || row.number === null ? null : { number: row.number, issueKind: row.issueKind };
}

/**
 * 確かめたコミットで、main から変えたファイルを 1 回だけ読む。ルールの確かめとテストの確かめの両方がこの結果を使う
 * @param forge GitHub
 * @param repo リポジトリ
 * @param sha 確かめたコミット
 * @returns 変えたファイルと道。GitHub の compare は 300 件で切れ、変えたファイルは最初のページだけに入る (Compare two commits)
 * @throws upstream_failed GitHub から読めない時
 */
export async function readPrFiles(forge: Forge, repo: string, sha: string): Promise<PrFiles> {
  const { files, truncated } = await forge.compare(repo, "main", sha);
  return { files, paths: files.flatMap((f) => (f.previousPath === undefined ? [f.path] : [f.path, f.previousPath])), truncated };
}

/**
 * bug と feature の子 Issue が、変えたファイルにテストのファイルを持つかを確かめ、外れていれば理由を返す。消したファイルは数えず、300 件で切れて見えない時は断る側に倒す。chore は断らない
 * @param child タスクの子
 * @param found 変えたファイル
 * @returns 外れた理由。通すなら null
 */
export function missingTests(child: ChildRef, found: PrFiles): string | null {
  if (child.issueKind !== "bug" && child.issueKind !== "feature") return null;
  if (found.truncated) return "変えたファイルが多すぎて、テストのファイルがあるか確かめられない。PR を分ける";
  return hasTestFile(found.files.filter((f) => f.status !== "removed").map((f) => f.path)) ? null : "bug と feature の PR は、変えたファイルにテストのファイル (*.test.*、*.spec.*) を含める";
}

/**
 * テストの確かめで外れた時の 422 を作る
 * @param reason 外れた理由
 * @returns 422 の AppError
 */
export function testsError(reason: string): AppError {
  return new AppError("validation_failed", reason, { errors: [{ pointer: "#/files", detail: reason }] });
}

/**
 * PR の本文の最後に、子 Issue を閉じる Closes を付ける。社員の本文はそのまま残す
 * @param body 社員の本文
 * @param number 子 Issue の番号
 * @returns 本文
 */
export function withCloses(body: string, number: number): string {
  const text = body.trimEnd();
  return `${text === "" ? "" : `${text}\n\n`}Closes #${String(number)}`;
}
