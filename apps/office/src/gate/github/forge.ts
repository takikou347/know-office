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
  GitHubPosted,
  GitHubPostedList,
  GitHubPull,
  GitHubRef,
  GitHubRepo,
  GitHubRuleset,
  GitHubRulesets,
  mainRuleset,
  RepoName,
  RULESET_NAME,
} from "@know-office/core";
import type { output, ZodType } from "zod";
import type { ChangedFile, Forge } from "../work/loop.ts";

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

/** GitHub のファイルの種類を、画面で分ける種類に寄せる。copied は足した物、changed と unchanged は変えた物とみる */
const FILE_STATUS: Readonly<Record<string, ChangedFile["status"]>> = { added: "added", copied: "added", removed: "removed", renamed: "renamed" };

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
  const readContents: Permissions = { contents: "read" };

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
  return {
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
      return { files: compare.files.map(changedFile), truncated: compare.files.length >= COMPARE_FILES };
    },
    readFile: async (repo, ref, path) => {
      const res = await send(repo, readContents, { method: "GET", path: `/contents/${filePath(path)}?ref=${ref}` });
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
    checksPassed: async (repo, sha) => {
      // 確かめたコミットのチェックを読む。プルリクエストの今の先は、確かめた後に進んでいるかもしれない
      const runs = await call(repo, { checks: "read" }, { method: "GET", path: `/commits/${commitSha(sha)}/check-runs` }, GitHubCheckRuns);
      // チェックが 1 つも無い時と、一覧に入り切らない時は通ったと言えない
      if (runs.check_runs.length === 0 || runs.total_count > runs.check_runs.length) return false;
      return runs.check_runs.every((r) => r.status === "completed" && r.conclusion !== null && PASSED.has(r.conclusion));
    },
    merge: async (repo, head) => {
      // ブランチの先を読み直さず、変えたファイルとチェックを確かめたコミットまで進める
      await call(repo, { contents: "write" }, { method: "PATCH", path: "/git/refs/heads/main" }, GitHubRef, { sha: commitSha(head.sha), force: false });
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
