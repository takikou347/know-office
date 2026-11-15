// GitHub の REST API を呼ぶ口。リポジトリ 1 つと要る権限に絞った鍵を呼ぶたびに付け、返事を Zod で確かめる (タスクとレビューの 3.3、3.4)
import {
  AppError,
  allowedFetch,
  type Fetcher,
  GitHubCheckRuns,
  GitHubCompare,
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
export type Permissions = Partial<Record<"contents" | "pull_requests" | "checks" | "administration" | "metadata", "read" | "write">>;

/** GitHub App の鍵の出し手。8.4 で vault の元の鍵から 1 時間の鍵を作る物につなぐ */
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
 * GitHub の REST API を呼ぶ口を作る
 * @param base GitHub の REST API の宛先 (本番は https://api.github.com)
 * @param fetcher 外への fetch
 * @param access 鍵の出し手
 * @returns GitHub を呼ぶ口
 */
export function httpForge(base: string, fetcher: Fetcher, access: GitHubAccess): Forge {
  const root = `${base.replace(/\/$/, "")}/`;

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
    const name = RepoName.safeParse(repo);
    if (!name.success) throw new AppError("upstream_failed", "リポジトリの名前の形が違う");
    const token = await access.token(name.data, permissions);
    const init: RequestInit = {
      method: route.method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await allowedFetch(fetcher, `${root}repos/${name.data}${route.path}`, [root], init);
    } catch {
      throw new AppError("upstream_failed", "GitHub に届かない");
    }
    if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new AppError("upstream_failed", "GitHub の返事の形が違う");
    return parsed.data;
  }

  const read: Permissions = { metadata: "read" };
  return {
    connected: true,
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
