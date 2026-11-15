// GitHub の REST API を呼ぶ口。リポジトリ 1 つと要る権限に絞った鍵を呼ぶたびに付け、返事を Zod で確かめる (タスクとレビューの 3.3、3.4)
import {
  AppError,
  allowedFetch,
  type Fetcher,
  GitHubCheckRuns,
  GitHubCompare,
  GitHubGitCommit,
  GitHubGitObject,
  GitHubPosted,
  GitHubPull,
  GitHubRef,
  GitHubRepo,
  GitHubRuleset,
  GitHubRulesets,
  mainRuleset,
  RepoName,
  RULESET_NAME,
} from "@know-office/core";
import type { ZodType } from "zod";
import type { Forge } from "../work/loop.ts";

/** 鍵に付ける権限。GitHub App の権限の名前と、読むか書くか */
export type Permissions = Partial<Record<"contents" | "pull_requests" | "issues" | "checks" | "statuses" | "administration" | "metadata", "read" | "write">>;

/** GitHub App の鍵の出し手。本番は github/app.ts の vault の元の鍵から 1 時間の鍵を作る物 */
export type GitHubAccess = {
  /** GitHub App の ID。ルールセットで main を進めてよい者に入れる */
  appId: number;
  /** リポジトリ 1 つと要る権限だけに絞った鍵を返す */
  token(repo: string, permissions: Permissions): Promise<string>;
};

/** compare API が 1 回で返すファイルの上限。届いたら残りがあるとみる */
const COMPARE_FILES = 300;

/** チェックが通ったとみる結果 */
const PASSED = new Set(["success", "neutral", "skipped"]);

/**
 * ブランチの名前を URL の道に入れる形にする。/ はそのまま残し、ほかを符号にする
 * @param branch ブランチの名前
 * @returns URL に入れる形
 * @throws upstream_failed . か .. の区切りがある時
 */
function branchPath(branch: string): string {
  const parts = branch.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new AppError("upstream_failed", "ブランチの名前の形が違う");
  return parts.map(encodeURIComponent).join("/");
}

/**
 * 返事を形で確かめる
 * @param res GitHub の返事
 * @param schema 返事の形
 * @returns 確かめた返事
 * @throws upstream_failed GitHub が失敗を返した時、返事の形が違う時
 */
async function parse<T>(res: Response, schema: ZodType<T>): Promise<T> {
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new AppError("upstream_failed", "GitHub の返事の形が違う");
  return parsed.data;
}

/**
 * GitHub の REST API を呼ぶ口を作る
 * @param base GitHub の REST API の宛先 (本番は https://api.github.com)
 * @param fetcher 外への fetch
 * @param access 鍵の出し手
 * @returns GitHub を呼ぶ口
 */
export function httpForge(base: string, fetcher: Fetcher, access: GitHubAccess): Forge {
  const root = `${base.replace(/\/$/, "")}/`;

  /**
   * 1 回呼ぶ。失敗のステータスも返事として返す
   * @param repo リポジトリ。形を確かめてから道に入れる
   * @param permissions 鍵に付ける権限
   * @param route メソッドと、/repos/{repo} より後ろの道
   * @param route.method メソッド
   * @param route.path 道
   * @param body 本文
   * @returns GitHub の返事
   * @throws upstream_failed リポジトリの形が違う時、GitHub に届かない時
   */
  async function send(repo: string, permissions: Permissions, route: { method: string; path: string }, body?: unknown): Promise<Response> {
    const name = RepoName.safeParse(repo);
    if (!name.success) throw new AppError("upstream_failed", "リポジトリの名前の形が違う");
    const token = await access.token(name.data, permissions);
    const init: RequestInit = {
      method: route.method,
      // GitHub への呼び出しはリダイレクトを追わず、3xx は失敗として断る (タスクとレビューの 3.3)
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await allowedFetch(fetcher, `${root}repos/${name.data}${route.path}`, [root], init);
    } catch {
      throw new AppError("upstream_failed", "GitHub に届かない");
    }
  }

  /**
   * 1 回呼び、返事を形で確かめる
   * @param repo リポジトリ。形を確かめてから道に入れる
   * @param permissions 鍵に付ける権限
   * @param route メソッドと、/repos/{repo} より後ろの道
   * @param route.method メソッド
   * @param route.path 道
   * @param schema 返事の形
   * @param body 本文
   * @returns 確かめた返事
   * @throws upstream_failed リポジトリの形が違う時、GitHub が失敗を返した時、返事の形が違う時
   */
  async function call<T>(repo: string, permissions: Permissions, route: { method: string; path: string }, schema: ZodType<T>, body?: unknown): Promise<T> {
    return parse(await send(repo, permissions, route, body), schema);
  }

  const read: Permissions = { metadata: "read" };
  const writePulls: Permissions = { pull_requests: "write" };
  const writeContents: Permissions = { contents: "write" };
  return {
    connected: () => Promise.resolve(true),
    postReview: async (repo, pr, review) => {
      const path = `/pulls/${String(pr)}/reviews`;
      const res = await send(repo, writePulls, { method: "POST", path }, { event: review.event, body: review.body, commit_id: review.commitId });
      // プルリクエストは App が出すので、GitHub は App が自分で可と不可を付ける事を 422 で断る。その時は判断を本文の頭に書いたコメントのレビューにする
      if (res.status === 422) {
        const label = review.event === "APPROVE" ? "承認" : "差し戻し";
        return (await call(repo, writePulls, { method: "POST", path }, GitHubPosted, { event: "COMMENT", body: `[${label}] ${review.body}`, commit_id: review.commitId })).id;
      }
      return (await parse(res, GitHubPosted)).id;
    },
    postComment: async (repo, pr, comment) => {
      const posted = await call(repo, writePulls, { method: "POST", path: `/pulls/${String(pr)}/comments` }, GitHubPosted, { body: comment.body, commit_id: comment.commitId, path: comment.path, line: comment.line, side: comment.side });
      return posted.id;
    },
    commitFile: async (repo, branch, change) => {
      const parent = await call(repo, { contents: "read" }, { method: "GET", path: `/git/commits/${change.parent}` }, GitHubGitCommit);
      const blob = await call(repo, writeContents, { method: "POST", path: "/git/blobs" }, GitHubGitObject, { content: change.content, encoding: "utf-8" });
      const tree = await call(repo, writeContents, { method: "POST", path: "/git/trees" }, GitHubGitObject, { base_tree: parent.tree.sha, tree: [{ path: change.path, mode: "100644", type: "blob", sha: blob.sha }] });
      const commit = await call(repo, writeContents, { method: "POST", path: "/git/commits" }, GitHubGitObject, { message: change.message, tree: tree.sha, parents: [change.parent] });
      // force を付けず、ブランチの先が親のままの時だけ進める。進んでいれば GitHub が 422 を返す
      const res = await send(repo, writeContents, { method: "PATCH", path: `/git/refs/heads/${branchPath(branch)}` }, { sha: commit.sha, force: false });
      if (res.status === 422) throw new AppError("conflict", "ブランチの先が進んだ");
      await parse(res, GitHubRef);
      return commit.sha;
    },
    openPull: async (input) => {
      const pull = await call(input.repo, { pull_requests: "write" }, { method: "POST", path: "/pulls" }, GitHubPull, { title: input.title, head: input.branch, base: "main", body: input.body });
      return { number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha };
    },
    checksPassed: async (repo, pr) => {
      const pull = await call(repo, { pull_requests: "read" }, { method: "GET", path: `/pulls/${String(pr)}` }, GitHubPull);
      const runs = await call(repo, { checks: "read" }, { method: "GET", path: `/commits/${pull.head.sha}/check-runs` }, GitHubCheckRuns);
      // チェックが 1 つも無い時と、一覧に入り切らない時は通ったと言えない
      if (runs.check_runs.length === 0 || runs.total_count > runs.check_runs.length) return false;
      return runs.check_runs.every((r) => r.status === "completed" && r.conclusion !== null && PASSED.has(r.conclusion));
    },
    merge: async (repo, branch) => {
      const ref = await call(repo, { contents: "read" }, { method: "GET", path: `/git/ref/heads/${branchPath(branch)}` }, GitHubRef);
      await call(repo, { contents: "write" }, { method: "PATCH", path: "/git/refs/heads/main" }, GitHubRef, { sha: ref.object.sha, force: false });
    },
    changedPaths: async (repo, branch) => {
      const compare = await call(repo, { contents: "read" }, { method: "GET", path: `/compare/main...${branchPath(branch)}` }, GitHubCompare);
      if (compare.files.length >= COMPARE_FILES) return null;
      return compare.files.flatMap((f) => (f.previous_filename === undefined ? [f.filename] : [f.filename, f.previous_filename]));
    },
    protectMain: async (repo, when) => {
      const info = await call(repo, read, { method: "GET", path: "" }, GitHubRepo);
      if (info.private) return "private";
      const runs = await call(repo, { checks: "read" }, { method: "GET", path: `/commits/${branchPath(info.default_branch)}/check-runs` }, GitHubCheckRuns);
      const body = mainRuleset(when, runs.check_runs.map((r) => r.name), access.appId);
      const admin: Permissions = { administration: "write" };
      const existing = (await call(repo, admin, { method: "GET", path: "/rulesets" }, GitHubRulesets)).find((r) => r.name === RULESET_NAME);
      // 同じ名前のルールセットを 2 つ作らないよう、あれば置き換える
      if (existing) await call(repo, admin, { method: "PUT", path: `/rulesets/${String(existing.id)}` }, GitHubRuleset, body);
      else await call(repo, admin, { method: "POST", path: "/rulesets" }, GitHubRuleset, body);
      return "applied";
    },
  };
}
