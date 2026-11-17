// 設計書から作る Issue のための GitHub の口。weekly と daily の見つけて直す仕組みの口 (IssueTracker) とは別にし、issue_plan だけが使う (開発の回し方の 3.3)
import { AppError } from "@know-office/core";

/** 一覧に出た Issue 1 件。プルリクエストは入れない */
export type DevIssue = { number: number; id: number; state: "open" | "closed"; body: string | null };

/** 設計書から作る Issue を扱う口 */
export type DevIssues = {
  /** サービスのリポジトリの Issue を、開閉を問わず新しい順に 1,000 件まで読む。読み切れなければ upstream_failed で断る */
  listIssues(repo: string): Promise<DevIssue[]>;
  /** Issue を作り、番号と ID を返す。ID は sub-issue のつなぎに使う */
  createIssue(repo: string, input: { title: string; body: string; labels: readonly string[] }): Promise<{ number: number; id: number }>;
  /** 親に子をつなぐ。子がすでにその親の子なら成功とみなす */
  linkSubIssue(repo: string, parent: number, childId: number): Promise<void>;
  /** 閉じた Issue を開き直す */
  reopen(repo: string, number: number): Promise<void>;
  /** Issue を閉じる。reason は GitHub の state_reason で、作り終えた completed か、外れた not_planned。閉じている Issue をもう一度閉じても成功する */
  close(repo: string, number: number, reason: "completed" | "not_planned"): Promise<void>;
  /** Issue にコメントを書く */
  comment(repo: string, number: number, body: string): Promise<void>;
  /** 本文に目印を含むコメントが Issue にあるかを、一覧の 1,000 件まで読んで返す。読み切れなければ upstream_failed で断る */
  hasComment(repo: string, number: number, marker: string): Promise<boolean>;
};

/** まだつないでいない口。呼ぶ操作は upstream_failed で断る */
export const UNCONNECTED_DEV_ISSUES: DevIssues = {
  listIssues: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  createIssue: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  linkSubIssue: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  reopen: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  close: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  comment: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
  hasComment: () => Promise.reject(new AppError("upstream_failed", "GitHub とまだつないでいない")),
};

/**
 * 遅れて決まる口に呼びを回す DevIssues を作る
 * @param load 口を出す関数
 * @returns 呼ぶたびに load の口へ回す口
 */
export function lazyDevIssues(load: () => Promise<DevIssues>): DevIssues {
  return {
    listIssues: async (repo) => (await load()).listIssues(repo),
    createIssue: async (repo, input) => (await load()).createIssue(repo, input),
    linkSubIssue: async (repo, parent, childId) => (await load()).linkSubIssue(repo, parent, childId),
    reopen: async (repo, number) => (await load()).reopen(repo, number),
    close: async (repo, number, reason) => (await load()).close(repo, number, reason),
    comment: async (repo, number, body) => (await load()).comment(repo, number, body),
    hasComment: async (repo, number, marker) => (await load()).hasComment(repo, number, marker),
  };
}
