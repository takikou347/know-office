// 見つけて直す仕組みが GitHub の Issue を作り、書き足し、閉じる口。GitHub の連携 (tasks.md の 8.4) でつなぐまでは断る (サービスと拡張の 3.7)
import { AppError } from "@know-office/core";

/** GitHub の Issue を扱う口。テストは代わりの物を渡す */
export type IssueTracker = {
  /** 本文に隠した指紋で、前に作った Issue を探す。無ければ null */
  findIssue(repo: string, fingerprint: string): Promise<number | null>;
  /** Issue を作り、番号を返す */
  createIssue(repo: string, input: { title: string; body: string }): Promise<number>;
  /** Issue に書き足す */
  comment(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Issue を閉じる */
  close(repo: string, issueNumber: number): Promise<void>;
};

/** まだつないでいない口。Issue の操作は upstream_failed で断り、呼んだ側がエラーログに残して次の回に作り直す */
export const UNCONNECTED_TRACKER: IssueTracker = {
  findIssue: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  createIssue: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  comment: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  close: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
};

/** リポジトリの名前の形 (owner/name)。GitHub が許す文字だけ */
export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Issue の本文に隠して入れる指紋の印を作る。画面には出ず、同じ原因の Issue を探す鍵になる
 * @param fingerprint 原因の指紋
 * @returns HTML のコメント
 */
export function fingerprintMark(fingerprint: string): string {
  return `<!-- know-office:fingerprint:${fingerprint} -->`;
}
