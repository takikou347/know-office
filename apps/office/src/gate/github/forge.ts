// GitHub の REST API を呼ぶ口。リポジトリ 1 つと要る権限に絞った鍵を呼ぶたびに付け、返事を Zod で確かめる (タスクとレビューの 3.3、3.4)
import {
  AppError,
  allowedFetch,
  CommitSha,
  type Fetcher,
  GitHubCheckRuns,
  GitHubCompare,
  GitHubContent,
  GitHubPullFiles,
  GitHubGitCommit,
  GitHubGitObject,
  GitHubGitTree,
  GitHubIssueCreated,
  GitHubIssueList,
  GitHubPosted,
  GitHubPostedList,
  GitHubPull,
  GitHubPullState,
  GitHubRef,
  GitHubRepo,
  GitHubRuleset,
  GitHubRulesets,
  mainRuleset,
  OWNER_APPROVAL_CONTEXT,
  RepoName,
  RULESET_NAME,
} from "@know-office/core";
import { z, type output, type ZodType } from "zod";
import type { DevIssues } from "../devloop/dev-issues.ts";
import type { ChangedFile, Forge } from "../work/loop.ts";
import { GITHUB_USER_AGENT, githubRetryAfter } from "./app.ts";
import { GitHubRateLimited } from "./rate-error.ts";

/** 鍵に付ける権限。GitHub App の権限の名前と、読むか書くか */
export type Permissions = Partial<Record<"contents" | "pull_requests" | "issues" | "checks" | "statuses" | "administration" | "metadata" | "actions", "read" | "write">>;

/** GitHub App の鍵の出し手。本番は github/app.ts の vault の元の鍵から 1 時間の鍵を作る物 */
export type GitHubAccess = {
  /** GitHub App の ID。ルールセットで main を進めてよい者に入れる */
  appId: number;
  /** リポジトリ 1 つと要る権限だけに絞った鍵を返す */
  token(repo: string, permissions: Permissions): Promise<string>;
};

/** compare API が 1 回で返すファイルの上限。届いたら残りがあるとみる。GET /repos/{o}/{r}/compare/{base}...{head} は、変わったファイルを最初のページだけに入れ、比べる全体で 300 件までしか返さない (GitHub の REST API の Compare two commits) */
const COMPARE_FILES = 300;

/** listFiles が返す件数の上限。超えたら null */
const LIST_FILES_MAX = 500;

/** プルリクエストのファイルの一覧のページの上限。GitHub は 3,000 件までしか返さない */
const PULL_FILE_PAGES = 30;

/** その場の直しのコミットの作者と入れた者。公開のリポジトリにオーナーの名前を残さない */
const COMMITTER = { name: "KNOW IDEA", email: "noreply@knowidea.invalid" };

/** 書き換えてよいファイルの mode。普通のファイルと実行できるファイル。120000 (シンボリックリンク) と 160000 (サブモジュール) は書き換えない */
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** 新しいファイルの mode */
const NEW_FILE_MODE = "100644";

/** レビューと行のコメントの一覧の 1 ページの数。GitHub の上限 */
const PAGE_SIZE = 100;

/** 目印を探す一覧のページの上限。1,000 件を超えるプルリクエストは読み切れないとして断る */
const LIST_PAGES = 10;

/** Issue を書く要求の間を空ける時間 (1 秒)。GitHub は POST、PATCH、PUT、DELETE を続けて送る時は 1 秒以上空けるよう求める (Best practices for using the REST API) */
export const WRITE_GAP_MS = 1000;

/** forge の設定。pause は書きの間を空ける待ち。テストは待たない物を渡す */
export type ForgeOptions = { pause?: (ms: number) => Promise<void> };

/** GitHub のファイルの種類を、画面で分ける種類に寄せる。copied は足した物、changed と unchanged は変えた物とみる */
const FILE_STATUS: Readonly<Record<string, ChangedFile["status"]>> = { added: "added", copied: "added", removed: "removed", renamed: "renamed" };

/**
 * compare の status が、head が base の先 (ahead か identical) かどうか
 * @param state status
 * @returns 先なら true
 */
const ahead = (state: string | undefined): boolean => state === "ahead" || state === "identical";

/**
 * GitHub の変わったファイルを、ゲートウェイの形にする
 * @param f compare かプルリクエストのファイルの一覧の 1 件
 * @returns 道、前の道、種類、差分の本文
 */
function changedFile(f: output<typeof GitHubPullFiles>[number]): ChangedFile {
  return {
    path: f.filename,
    ...(f.previous_filename === undefined ? {} : { previousPath: f.previous_filename }),
    status: FILE_STATUS[f.status ?? ""] ?? "modified",
    patch: f.patch ?? null,
  };
}

/**
 * ファイルの道を URL の道に入れる形にする。/ はそのまま残し、区切りごとに符号にする
 * @param path 確かめたファイルの道
 * @returns URL に入れる形
 */
function filePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * base64 の中身を UTF-8 の文字にする。GitHub は 60 字ごとに改行を入れる
 * @param content base64
 * @returns 文字
 */
function fromBase64(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** チェックが通ったとみる結果 */
/** 動かせる workflow のファイルの名前 */
const WORKFLOW_FILE = /^[A-Za-z0-9_-]{1,100}\.ya?ml$/;

const PASSED = new Set(["success", "neutral", "skipped"]);

/**
 * コミットの SHA を URL の道と本文に入れる前に形を確かめる
 * @param sha コミットの SHA
 * @returns 確かめた SHA
 * @throws internal 40 字の 16 進数でない時
 */
function commitSha(sha: string): string {
  const parsed = CommitSha.safeParse(sha);
  if (!parsed.success) throw new AppError("internal", "コミットの形が違う");
  return parsed.data;
}

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
 * @param options 待ちの差し替え (テストは待たない物を渡す)
 * @returns GitHub を呼ぶ口
 */
export function httpForge(base: string, fetcher: Fetcher, access: GitHubAccess, options: ForgeOptions = {}): Forge {
  const root = `${base.replace(/\/$/, "")}/`;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms)));

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
   * @throws rate_limited GitHub の上限に当たった時
   */
  async function send(repo: string, permissions: Permissions, route: { method: string; path: string }, body?: unknown): Promise<Response> {
    const name = RepoName.safeParse(repo);
    if (!name.success) throw new AppError("upstream_failed", "リポジトリの名前の形が違う");
    const token = await access.token(name.data, permissions);
    const init: RequestInit = {
      method: route.method,
      // GitHub への呼び出しはリダイレクトを追わず、3xx は失敗として断る (タスクとレビューの 3.3)
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": GITHUB_USER_AGENT, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await allowedFetch(fetcher, `${root}repos/${name.data}${route.path}`, [root], init);
    } catch {
      throw new AppError("upstream_failed", "GitHub に届かない");
    }
    const wait = githubRetryAfter(res);
    if (wait !== null) throw new GitHubRateLimited(wait);
    return res;
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
  const readContents: Permissions = { contents: "read" };
  /**
   * compare の range (base...head) の status。head が base に対して identical、ahead、behind、diverged のどれか
   * @param repo リポジトリ
   * @param range base...head
   * @returns status
   */
  const compareState = async (repo: string, range: string): Promise<string | undefined> => (await call(repo, readContents, { method: "GET", path: `/compare/${range}` }, GitHubCompare)).status;

  /**
   * 書き換えるファイルの今の mode を、親のコミットの木から 1 階ずつ読む
   * @param repo リポジトリ
   * @param top 親のコミットの木の sha
   * @param path 書き換えるファイルの道
   * @returns 引き継ぐ mode。無い新しいファイルは 100644
   * @throws rule_denied シンボリックリンクかサブモジュールか、道の途中がフォルダでない時
   * @throws upstream_failed 木を読めないか、読み切れない時
   */
  async function modeOf(repo: string, top: string, path: string): Promise<string> {
    const parts = path.split("/");
    let tree = top;
    for (const [i, name] of parts.entries()) {
      const listing = await call(repo, readContents, { method: "GET", path: `/git/trees/${tree}` }, GitHubGitTree);
      const entry = listing.tree.find((e) => e.path === name);
      if (entry === undefined) {
        if (listing.truncated) throw new AppError("upstream_failed", "木を読み切れない");
        return NEW_FILE_MODE;
      }
      if (i === parts.length - 1) {
        if (FILE_MODES.has(entry.mode)) return entry.mode;
        throw new AppError("rule_denied", "シンボリックリンクとサブモジュールは書き換えない");
      }
      if (entry.type !== "tree") throw new AppError("rule_denied", "道の途中がフォルダでない");
      tree = entry.sha;
    }
    return NEW_FILE_MODE;
  }
  const writeContents: Permissions = { contents: "write" };
  const issuesRead: Permissions = { issues: "read" };
  const issuesWrite: Permissions = { issues: "write" };
  let wrote = false;

  /**
   * Issue への書きを 1 つずつ、前の書きから 1 秒空けて送る
   * @param action 書き
   * @returns 書きの結果
   */
  async function paced<T>(action: () => Promise<T>): Promise<T> {
    if (wrote) await pause(WRITE_GAP_MS);
    wrote = true;
    return action();
  }

  /**
   * 100 件の頁を最大 10 頁まで読み、読み切れた時だけ全部を返す
   * @param repo リポジトリ
   * @param path 頁の番号を付ける前の道 (クエリ付き)
   * @param schema 1 頁の形
   * @returns 全部の項目
   * @throws upstream_failed 10 頁を読んでも続きがある時
   */
  async function allPages<T>(repo: string, path: string, schema: ZodType<T[]>): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= LIST_PAGES; page += 1) {
      const list = await call(repo, issuesRead, { method: "GET", path: `${path}${path.includes("?") ? "&" : "?"}per_page=${String(PAGE_SIZE)}&page=${String(page)}` }, schema);
      all.push(...list);
      if (list.length < PAGE_SIZE) return all;
    }
    // 読み切れない時は、無いと言えないので作らずに断る
    throw new AppError("upstream_failed", "Issue の一覧を読み切れない");
  }

  // GET /repos/{o}/{r}/issues は state=all、sort=created、direction=desc、per_page は 100 まで、頁で続きを読む。プルリクエストも混じり pull_request の項目で分かる (GitHub の REST API の Issues)
  // POST /repos/{o}/{r}/issues は 201 で number と id を返す。PATCH /issues/{n} の state と state_reason (not_planned、reopened) で閉じ、開き直す
  // POST /repos/{o}/{r}/issues/{n}/sub_issues は sub_issue_id に子の番号でなく ID を取り、201 を返す。1 つの親に 100 件まで、8 階層まで (GitHub の REST API の Sub-issues、Adding sub-issues)
  // 書く要求は GitHub の決まりで、1 分に 80 件、1 時間に 500 件までの content creation と、続けて送る時の 1 秒の間がある (Rate limits for the REST API、Best practices for using the REST API)
  const issues: DevIssues = {
    listIssues: async (repo) => {
      const all = await allPages(repo, "/issues?state=all&sort=created&direction=desc", GitHubIssueList);
      return all.flatMap((i) => (i.pull_request === undefined ? [{ number: i.number, id: i.id, state: i.state, body: i.body ?? null }] : []));
    },
    createIssue: (repo, input) => paced(() => call(repo, issuesWrite, { method: "POST", path: "/issues" }, GitHubIssueCreated, { title: input.title, body: input.body, labels: input.labels })).then((i) => ({ number: i.number, id: i.id })),
    linkSubIssue: (repo, parent, childId) =>
      paced(async () => {
        const res = await send(repo, issuesWrite, { method: "POST", path: `/issues/${String(parent)}/sub_issues` }, { sub_issue_id: childId });
        if (res.ok) return;
        // 422 は検証の失敗で、すでにこの親の子の時もある。親の子の一覧に子がいる時だけ成功とみなし、ほかの 422 は断る
        if (res.status !== 422) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
        const subs = await allPages(repo, `/issues/${String(parent)}/sub_issues`, GitHubIssueList);
        if (!subs.some((i) => i.id === childId)) throw new AppError("upstream_failed", "GitHub が sub-issue のつなぎを断った");
      }),
    reopen: (repo, number) => paced(() => call(repo, issuesWrite, { method: "PATCH", path: `/issues/${String(number)}` }, GitHubIssueCreated, { state: "open", state_reason: "reopened" })).then(() => undefined),
    close: (repo, number, reason) => paced(() => call(repo, issuesWrite, { method: "PATCH", path: `/issues/${String(number)}` }, GitHubIssueCreated, { state: "closed", state_reason: reason })).then(() => undefined),
    comment: (repo, number, body) => paced(() => call(repo, issuesWrite, { method: "POST", path: `/issues/${String(number)}/comments` }, GitHubPosted, { body })).then(() => undefined),
    hasComment: async (repo, number, marker) => (await allPages(repo, `/issues/${String(number)}/comments`, GitHubPostedList)).some((c) => c.body?.includes(marker) === true),
  };
  return {
    issues,
    pullFiles: async (repo, pr) => {
      const files: output<typeof GitHubPullFiles> = [];
      // 1 ページは 100 件まで。満ちていれば続きを読み、GitHub の上限の 30 ページまで満ちていれば読み切れないとして断る
      for (let page = 1; ; page += 1) {
        const list = await call(repo, { pull_requests: "read" }, { method: "GET", path: `/pulls/${String(pr)}/files?per_page=${String(PAGE_SIZE)}&page=${String(page)}` }, GitHubPullFiles);
        files.push(...list);
        if (list.length < PAGE_SIZE) return files.map(changedFile);
        if (page === PULL_FILE_PAGES) throw new AppError("upstream_failed", "変えたファイルが多すぎて読み切れない");
      }
    },
    compare: async (repo, from, to) => {
      const compare = await call(repo, readContents, { method: "GET", path: `/compare/${from}...${to}` }, GitHubCompare);
      return { files: compare.files.map(changedFile), truncated: compare.files.length >= COMPARE_FILES, baseSha: compare.merge_base_commit?.sha ?? null };
    },
    readFile: async (repo, ref, path) => {
      // ref は道に入るので、コミットの形だけを通す
      const res = await send(repo, readContents, { method: "GET", path: `/contents/${filePath(path)}?ref=${commitSha(ref)}` });
      if (res.status === 404) return null;
      const file = await parse(res, GitHubContent);
      // フォルダ、シンボリックリンク、サブモジュールはファイルの中身として返さない
      if (file.type !== "file") return null;
      // 1MB を超えるファイルは中身が来ない
      if (file.encoding !== "base64") throw new AppError("upstream_failed", "ファイルが大きすぎて読めない");
      return fromBase64(file.content);
    },
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
    postStatus: async (repo, sha, status) => {
      // GitHub の POST /repos/{owner}/{repo}/statuses/{sha}。説明は 140 字まで、同じ sha と名前で 1,000 件まで
      const body = { state: status.state, context: OWNER_APPROVAL_CONTEXT, description: status.description };
      return (await call(repo, { statuses: "write" }, { method: "POST", path: `/statuses/${sha}` }, GitHubPosted, body)).id;
    },
    commitFile: async (repo, branch, change) => {
      const parent = await call(repo, readContents, { method: "GET", path: `/git/commits/${change.parent}` }, GitHubGitCommit);
      // ファイルを書き換える前に今の mode を読み、シンボリックリンクとサブモジュールを断る。何も作らずに断るので、blob より先に読む
      const mode = await modeOf(repo, parent.tree.sha, change.path);
      const blob = await call(repo, writeContents, { method: "POST", path: "/git/blobs" }, GitHubGitObject, { content: change.content, encoding: "utf-8" });
      const tree = await call(repo, writeContents, { method: "POST", path: "/git/trees" }, GitHubGitObject, { base_tree: parent.tree.sha, tree: [{ path: change.path, mode, type: "blob", sha: blob.sha }] });
      const commit = await call(repo, writeContents, { method: "POST", path: "/git/commits" }, GitHubGitObject, {
        message: change.message,
        tree: tree.sha,
        parents: [change.parent],
        author: COMMITTER,
        committer: COMMITTER,
      });
      // force を付けず、ブランチの先が親のままの時だけ進める。進んでいれば GitHub が 422 を返す
      const res = await send(repo, writeContents, { method: "PATCH", path: `/git/refs/heads/${branchPath(branch)}` }, { sha: commit.sha, force: false });
      if (res.status === 422) throw new AppError("conflict", "ブランチの先が進んだ");
      await parse(res, GitHubRef);
      return commit.sha;
    },
    findMirror: async (repo, pr, kind, marker) => {
      const what = kind === "review" ? "reviews" : "comments";
      for (let page = 1; page <= LIST_PAGES; page += 1) {
        const list = await call(repo, { pull_requests: "read" }, { method: "GET", path: `/pulls/${String(pr)}/${what}?per_page=${String(PAGE_SIZE)}&page=${String(page)}` }, GitHubPostedList);
        const found = list.find((p) => p.body?.includes(marker) === true);
        if (found) return found.id;
        if (list.length < PAGE_SIZE) return null;
      }
      // 読み切れない時は、無いと言えないので送らずに断る
      throw new AppError("upstream_failed", "レビューの一覧を読み切れない");
    },
    openPull: async (input) => {
      const pull = await call(input.repo, { pull_requests: "write" }, { method: "POST", path: "/pulls" }, GitHubPull, { title: input.title, head: input.branch, base: "main", body: input.body });
      return { number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha };
    },
    // GET /repos/{o}/{r}/pulls/{n}。入ったプルリクエストは state が closed のまま merged が true になる
    pullState: async (repo, pr) => call(repo, { pull_requests: "read" }, { method: "GET", path: `/pulls/${String(pr)}` }, GitHubPullState).then((pull) => ({ state: pull.merged ? "merged" : pull.state, headSha: pull.head.sha })),
    checkState: async (repo, sha) => {
      // 確かめたコミットのチェックを読む。プルリクエストの今の先は、確かめた後に進んでいるかもしれない
      const runs = await call(repo, { checks: "read" }, { method: "GET", path: `/commits/${commitSha(sha)}/check-runs` }, GitHubCheckRuns);
      // 読めた中に 1 つでも終えて通らなかった物があれば落ちた
      if (runs.check_runs.some((r) => r.status === "completed" && (r.conclusion === null || !PASSED.has(r.conclusion)))) return "failed";
      // チェックが 1 つも無い時と、一覧に入り切らない時は、通ったとも落ちたとも言えない
      if (runs.check_runs.length === 0 || runs.total_count > runs.check_runs.length) return "pending";
      return runs.check_runs.every((r) => r.status === "completed") ? "passed" : "pending";
    },
    merge: async (repo, head) => {
      // ブランチの先を読み直さず、変えたファイルとチェックを確かめたコミットまで進める
      const res = await send(repo, { contents: "write" }, { method: "PATCH", path: "/git/refs/heads/main" }, { sha: commitSha(head.sha), force: false });
      // 返事の形も確かめてから、進めたとみなす
      if (res.ok) return parse(res, GitHubRef).then(() => "merged" as const);
      if (res.status !== 422) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
      // 422 は fast-forward にならない時のほか、ルールセットが断った時もある。main と確かめたコミットを比べ、main が先に進んでいる (behind か diverged) 時だけ behind にする
      if (["diverged", "behind"].includes((await compareState(repo, `main...${commitSha(head.sha)}`)) ?? "")) return "behind";
      throw new AppError("upstream_failed", "GitHub が main を進める更新を断った");
    },
    // main からコミットまでが ahead (main がコミットの祖先) か identical なら、fast-forward で進められる
    fastForwardable: async (repo, sha) => ahead(await compareState(repo, `main...${commitSha(sha)}`)),
    pullOf: async (repo, branch) => {
      // GET /repos/{o}/{r}/pulls は head に `<owner>:<ブランチ>` を取り、state=open で開いた PR だけを返す (GitHub の REST API の List pull requests)。同じブランチの開いた PR は 1 本なので 2 件読めば足りる
      const [pull] = await call(repo, { pull_requests: "read" }, { method: "GET", path: `/pulls?head=${encodeURIComponent(`${repo.split("/")[0] ?? ""}:${branch}`)}&state=open&per_page=2` }, z.array(GitHubPull));
      return pull === undefined || pull.head.ref !== branch ? null : { number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha };
    },
    // main が確かめたコミットを含めば、main はコミットから見て ahead か identical
    inMain: async (repo, sha) => ahead(await compareState(repo, `${commitSha(sha)}...main`)),
    changedPaths: async (repo, branch) => {
      const compare = await call(repo, { contents: "read" }, { method: "GET", path: `/compare/main...${branchPath(branch)}` }, GitHubCompare);
      if (compare.files.length >= COMPARE_FILES) return null;
      return compare.files.flatMap((f) => (f.previous_filename === undefined ? [f.filename] : [f.filename, f.previous_filename]));
    },
    dispatchWorkflow: async (repo, workflow, inputs) => {
      if (!WORKFLOW_FILE.test(workflow)) throw new AppError("internal", "workflow の名前の形が違う");
      // 動かすのは既定のブランチ。GitHub の決まりで、workflow_dispatch はブランチかタグを ref に取る
      const info = await call(repo, read, { method: "GET", path: "" }, GitHubRepo);
      // POST /repos/{o}/{r}/actions/workflows/{file}/dispatches は 204 を返す (GitHub の REST API の Workflows)
      const res = await send(repo, { actions: "write" }, { method: "POST", path: `/actions/workflows/${workflow}/dispatches` }, { ref: info.default_branch, inputs });
      if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
      return info.default_branch;
    },
    branchHead: async (repo, branch) => commitSha((await call(repo, readContents, { method: "GET", path: `/git/ref/heads/${branchPath(branch)}` }, GitHubRef)).object.sha),
    // GET /repos/{o}/{r}/git/ref/heads/{branch} は名前の完全に合う ref だけを返し、無ければ 404 (GitHub の REST API の Get a reference)
    findBranchHead: async (repo, branch) => send(repo, readContents, { method: "GET", path: `/git/ref/heads/${branchPath(branch)}` }).then(async (res) => (res.status === 404 ? null : commitSha((await parse(res, GitHubRef)).object.sha))),
    listFiles: async (repo, ref, prefix) => {
      // GET /repos/{o}/{r}/git/trees/{tree_sha}?recursive=1 は、木が 100,000 件か 7MB を超えると truncated を true にして切る (GitHub の REST API の Git trees)
      const tree = await call(repo, readContents, { method: "GET", path: `/git/trees/${commitSha(ref)}?recursive=1` }, GitHubGitTree);
      if (tree.truncated) return null;
      const found = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => e.path);
      // 設計書 1 つの木としては多すぎる。読み切れない物として扱う
      return found.length > LIST_FILES_MAX ? null : found;
    },
    defaultHead: async (repo) => {
      const info = await call(repo, read, { method: "GET", path: "" }, GitHubRepo);
      const ref = await call(repo, readContents, { method: "GET", path: `/git/ref/heads/${branchPath(info.default_branch)}` }, GitHubRef);
      return commitSha(ref.object.sha);
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
