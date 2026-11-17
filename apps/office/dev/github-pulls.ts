// 開発環境の代わりの GitHub のうち、プルリクエストのレビューと行のコメント、Git の API (blobs、trees、commits、ブランチの先)、workflow を動かす要求に答える所。GitHub の決まりのうち know-office が当たる所だけを持つ
import { z } from "zod";

/** プルリクエストのレビューを出す要求。GitHub の POST /repos/{o}/{r}/pulls/{n}/reviews */
const ReviewRequest = z.object({ event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional(), commit_id: z.string().optional() }).loose();
/** 行のコメントを出す要求。GitHub の POST /repos/{o}/{r}/pulls/{n}/comments */
const CommentRequest = z.object({ body: z.string().min(1), commit_id: z.string(), path: z.string().min(1), line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]) }).loose();
/** プルリクエストを出す要求。GitHub の POST /repos/{o}/{r}/pulls */
const PullRequest = z.object({ title: z.string().min(1), head: z.string().min(1), base: z.string().min(1), body: z.string().optional() }).loose();
/** Git の API の要求のうち使う所 */
const BlobRequest = z.object({ content: z.string(), encoding: z.enum(["utf-8", "base64"]) }).loose();
const TreeRequest = z.object({ base_tree: z.string(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() }).loose()) }).loose();
const CommitRequest = z.object({ message: z.string(), tree: z.string(), parents: z.array(z.string()) }).loose();
const RefRequest = z.object({ sha: z.string(), force: z.boolean().optional() }).loose();
/** コミットのステータスを出す要求。GitHub の POST /repos/{o}/{r}/statuses/{sha}。説明は 140 字まで */
const StatusRequest = z.object({ state: z.enum(["error", "failure", "pending", "success"]), context: z.string().min(1).optional(), description: z.string().max(140).optional(), target_url: z.string().optional() }).strict();
/** workflow を動かす要求。GitHub の POST /repos/{o}/{r}/actions/workflows/{file}/dispatches */
const DispatchRequest = z.object({ ref: z.string().min(1), inputs: z.record(z.string(), z.string()).optional() }).strict();

/** GitHub で操作した者。key は同じ者かを比べる印、login は通知に載る名前 */
export type FakeActor = { key: string; login: string };

/** レビューと Git の API の代わりが使う、代わりの GitHub の中身 */
export type PullsDeps = {
  /** 鍵から操作した者を決める */
  actorOf(token: string | null): FakeActor;
  /** 鍵がリポジトリへの権限を持つか */
  allows(token: string | null, repo: string, name: string, level: "read" | "write"): boolean;
  /** 鍵のインストール ID。分からなければ 0 */
  installationOf(token: string | null): number;
  /** 続き番号 */
  next(): number;
  /** PR の番号を取る。GitHub は Issue と PR でリポジトリごとの 1 つの番号を使うので、Issue と同じ数え方で取る */
  claimNumber(repo: string, title: string): number;
  /** 受けたレビューと行のコメントの後に GitHub が送る通知 */
  sent: { event: string; payload: unknown }[];
  /** ブランチの先のコミット。「owner/name:ブランチ」から */
  heads: Map<string, string>;
  /** Git の木の中身。木の sha から。無い木は空の木として返す */
  trees: Map<string, FakeTreeEntry[]>;
  /** 受けたレビューと行のコメント */
  posted: FakePosted;
};

/** Git の木の 1 項目 */
export type FakeTreeEntry = { path: string; mode: string; type: string; sha: string };

/** 受けたレビューと行のコメント。一覧の API が返す */
export type FakePosted = { reviews: FakePost[]; comments: FakePost[] };

/** 受けたレビューか行のコメント 1 つ */
export type FakePost = { repo: string; pr: number; id: number; body: string; payload: unknown };

/** レビューと Git の API の代わり */
export type FakePulls = {
  /** プルリクエストを出した者を覚える */
  opened(repo: string, number: number, token: string | null): void;
  /** 要求に答える。当たらなければ null */
  answer(route: string, text: string, token: string | null, query?: URLSearchParams): Response | null;
};

const invalid = () => Response.json({ message: "Invalid request" }, { status: 422 });
const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
const forbidden = () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 });

/**
 * レビューと Git の API の代わりを作る
 * @param deps 代わりの GitHub の中身
 * @returns 出した者を覚える口と、答える口
 */
export function createFakePulls(deps: PullsDeps): FakePulls {
  /** プルリクエストを出した者。「owner/name#番号」から */
  const authors = new Map<string, string>();
  /** Git の API で作ったコミットの親と木 */
  const commits = new Map<string, { parents: string[]; tree: string }>();

  /**
   * 40 桁の 16 進数の sha を作る
   * @returns sha
   */
  const newSha = (): string => `${crypto.randomUUID().replaceAll("-", "")}${String(deps.next()).padStart(8, "0")}`.slice(0, 40);

  /**
   * レビューか行のコメントを受け、GitHub と同じ通知を sent に積む
   * @param repo owner/name
   * @param num プルリクエストの番号
   * @param what reviews か comments
   * @param body 本文
   * @param token 付いていた鍵
   * @returns 返事
   */
  const pull = (repo: string, num: number, what: string, body: unknown, token: string | null): Response => {
    if (!deps.allows(token, repo, "pull_requests", "write")) return forbidden();
    const actor = deps.actorOf(token);
    const user = { login: actor.login, type: "Bot" };
    const head = { pull_request: { number: num }, repository: { full_name: repo }, installation: { id: deps.installationOf(token) }, sender: user };
    const id = 5000 + deps.next();
    if (what === "reviews") {
      const input = ReviewRequest.safeParse(body);
      if (!input.success) return invalid();
      // GitHub は、プルリクエストを出した者が自分で可と不可を付ける事を断る
      if (input.data.event !== "COMMENT" && authors.get(`${repo}#${String(num)}`) === actor.key) {
        return Response.json({ message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] }, { status: 422 });
      }
      if (input.data.event !== "APPROVE" && !input.data.body) return Response.json({ message: "Body is required" }, { status: 422 });
      const reviewState = { APPROVE: "approved", REQUEST_CHANGES: "changes_requested", COMMENT: "commented" }[input.data.event];
      const review = { id, state: reviewState, body: input.data.body ?? "", commit_id: input.data.commit_id ?? null, user, author_association: "NONE" };
      deps.sent.push({ event: "pull_request_review", payload: { action: "submitted", review, ...head } });
      deps.posted.reviews.push({ repo, pr: num, id, body: review.body, payload: review });
      return Response.json(review);
    }
    const input = CommentRequest.safeParse(body);
    if (!input.success) return invalid();
    const comment = { id, body: input.data.body, path: input.data.path, line: input.data.line, side: input.data.side, commit_id: input.data.commit_id, user, author_association: "NONE" };
    deps.sent.push({ event: "pull_request_review_comment", payload: { action: "created", comment, ...head } });
    deps.posted.comments.push({ repo, pr: num, id, body: comment.body, payload: comment });
    return Response.json(comment, { status: 201 });
  };

  const made = new Map<string, unknown>();
  /**
   * POST /repos/{o}/{r}/pulls に答える。ブランチの先が無ければ 422
   * @param repo owner/name
   * @param body 本文
   * @param token 鍵
   * @returns 返事
   */
  const open = (repo: string, body: unknown, token: string | null): Response => {
    if (!deps.allows(token, repo, "pull_requests", "write")) return forbidden();
    const input = PullRequest.safeParse(body);
    const head = input.success ? deps.heads.get(`${repo}:${input.data.head}`) : undefined;
    if (!input.success || head === undefined) return invalid();
    const number = deps.claimNumber(repo, input.data.title);
    const opened1 = { number, title: input.data.title, body: input.data.body ?? "", base: { ref: input.data.base, sha: deps.heads.get(`${repo}:${input.data.base}`) ?? "0".repeat(40) }, head: { ref: input.data.head, sha: head }, state: "open" };
    made.set(`${repo}#${String(number)}`, opened1);
    authors.set(`${repo}#${String(number)}`, deps.actorOf(token).key);
    return Response.json(opened1, { status: 201 });
  };

  /**
   * Git の API の要求に答える
   * @param method メソッド
   * @param repo owner/name
   * @param what blobs、trees、commits、refs/heads
   * @param rest 道の残り (sha かブランチ)
   * @param body 本文
   * @returns 返事。当たらなければ null
   */
  const git = (method: string, repo: string, what: string, rest: string, body: unknown): Response | null => {
    if (method === "GET" && what === "trees") return Response.json({ sha: rest, tree: deps.trees.get(rest) ?? [], truncated: false });
    if (method === "GET" && what === "commits") {
      const found = commits.get(rest);
      // 知らないコミットは、ブランチの頭として木を持つ物にする。木の sha は 16 進数の並びを逆にした物
      return Response.json({ sha: rest, tree: { sha: found?.tree ?? rest.split("").toReversed().join("") }, parents: (found?.parents ?? []).map((sha) => ({ sha })) });
    }
    if (method === "POST" && what === "blobs") return BlobRequest.safeParse(body).success ? Response.json({ sha: newSha() }, { status: 201 }) : invalid();
    if (method === "POST" && what === "trees") return TreeRequest.safeParse(body).success ? Response.json({ sha: newSha() }, { status: 201 }) : invalid();
    if (method === "POST" && what === "commits") {
      const input = CommitRequest.safeParse(body);
      if (!input.success) return invalid();
      const sha = newSha();
      commits.set(sha, { parents: input.data.parents, tree: input.data.tree });
      return Response.json({ sha }, { status: 201 });
    }
    // GET /git/ref/heads/{ブランチ} は先を返し、DELETE /git/refs/heads/{ブランチ} は消す (GitHub の REST API の Git references)
    if (method === "GET" && what === "ref/heads") {
      const sha = deps.heads.get(`${repo}:${rest}`);
      return sha === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json({ ref: `refs/heads/${rest}`, object: { sha } });
    }
    if (method === "DELETE" && what === "refs/heads") return deps.heads.delete(`${repo}:${rest}`) ? new Response(null, { status: 204 }) : Response.json({ message: "Reference does not exist" }, { status: 422 });
    if (method === "PATCH" && what === "refs/heads") {
      const input = RefRequest.safeParse(body);
      if (!input.success) return invalid();
      const key = `${repo}:${rest}`;
      const current = deps.heads.get(key);
      // force の無い更新は、今の先を親に持つコミットだけを受ける
      if (current !== undefined && input.data.force !== true && !(commits.get(input.data.sha)?.parents.includes(current) ?? false)) return Response.json({ message: "Update is not a fast forward" }, { status: 422 });
      deps.heads.set(key, input.data.sha);
      return Response.json({ ref: `refs/heads/${rest}`, object: { sha: input.data.sha } });
    }
    return null;
  };

  /**
   * コミットの祖先 (自分を含む) を、親をたどって集める。知らないコミットは自分だけ
   * @param sha コミット
   * @returns 祖先の sha
   */
  const ancestors = (sha: string): Set<string> => {
    const seen = new Set<string>();
    const pending = [sha];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(commits.get(next)?.parents ?? []));
    }
    return seen;
  };

  /**
   * GET /repos/{o}/{r}/compare/{base}...{head} に答える。status は head が base に対して identical、ahead (base を含む)、behind (base に含まれる)、diverged のどれか。
   * main は PATCH で進めた先で、まだ進めていなければ全部のコミットの祖先とみなす。変わったファイルは、テストのファイル 1 つ (置いた返事が無い時の既定)
   * @param repo owner/name
   * @param base 比べる元。main かコミット
   * @param head 比べる先。main かコミット
   * @returns 返事
   */
  const compare = (repo: string, base: string, head: string): Response => {
    const main = deps.heads.get(`${repo}:main`);
    const unset = (name: string) => name === "main" && main === undefined;
    const [from, to] = [base === "main" ? (main ?? "") : base, head === "main" ? (main ?? "") : head];
    let status = "diverged";
    if (unset(base)) status = "ahead";
    else if (unset(head)) status = "diverged";
    else if (from === to) status = "identical";
    else if (ancestors(to).has(from)) status = "ahead";
    else if (ancestors(from).has(to)) status = "behind";
    return Response.json({ status, files: [{ filename: "src/feature.test.ts", status: "added", patch: "@@ -0,0 +1 @@\n+test" }] });
  };

  return {
    opened: (repo, number, token) => void authors.set(`${repo}#${String(number)}`, deps.actorOf(token).key),
    answer: (route, text, token, query) => {
      const body: unknown = text ? JSON.parse(text) : null;
      // GET /repos/{o}/{r}/pulls?head=<owner>:<ブランチ>&state=open は、そのブランチで開いている PR を返す (GitHub の REST API の List pull requests)
      const listed = /^GET \/repos\/([^/]+\/[^/]+)\/pulls$/.exec(route);
      if (listed) {
        if (!deps.allows(token, listed[1] ?? "", "pull_requests", "read")) return forbidden();
        const branch = (query?.get("head") ?? "").split(":").slice(1).join(":");
        const per = Number(query?.get("per_page") ?? "30");
        return Response.json([...made.entries()].filter(([key, pr]) => key.startsWith(`${listed[1] ?? ""}#`) && (pr as { head?: { ref?: string } }).head?.ref === branch).map(([, pr]) => pr).slice(0, per));
      }
      // 出した PR は、先をブランチの先と main の先に決めて覚え、GET で本文を読める。置いた返事 (fakeGitHubRoute) がある道は、呼ぶ側がこれより先に答える
      const created = /^POST \/repos\/([^/]+\/[^/]+)\/pulls$/.exec(route);
      if (created) return open(created[1] ?? "", body, token);
      const read = /^GET \/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(route);
      if (read) {
        if (!deps.allows(token, read[1] ?? "", "pull_requests", "read")) return forbidden();
        const found = made.get(`${read[1] ?? ""}#${read[2] ?? ""}`);
        return found === undefined ? notFound() : Response.json(found);
      }
      const review = /^POST \/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/(reviews|comments)$/.exec(route);
      if (review) return pull(review[1] ?? "", Number(review[2]), review[3] ?? "", body, token);
      const list = /^GET \/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/(reviews|comments)$/.exec(route);
      if (list) {
        const [, repo = "", num = "", what = ""] = list;
        if (!deps.allows(token, repo, "pull_requests", "read")) return forbidden();
        const posts = what === "reviews" ? deps.posted.reviews : deps.posted.comments;
        return Response.json(posts.filter((p) => p.repo === repo && p.pr === Number(num)).map((p) => p.payload));
      }
      const status = /^POST \/repos\/([^/]+\/[^/]+)\/statuses\/([0-9a-f]{40})$/.exec(route);
      if (status) {
        if (!deps.allows(token, status[1] ?? "", "statuses", "write")) return forbidden();
        const input = StatusRequest.safeParse(body);
        return input.success ? Response.json({ id: 7000 + deps.next(), ...input.data, context: input.data.context ?? "default" }, { status: 201 }) : invalid();
      }
      const dispatch = /^POST \/repos\/([^/]+\/[^/]+)\/actions\/workflows\/[^/]+\/dispatches$/.exec(route);
      if (dispatch) {
        if (!deps.allows(token, dispatch[1] ?? "", "actions", "write")) return forbidden();
        // GitHub は受けると本文の無い 204 を返す
        return DispatchRequest.safeParse(body).success ? new Response(null, { status: 204 }) : invalid();
      }
      const diff = /^GET \/repos\/([^/]+\/[^/]+)\/compare\/([^.]+)\.\.\.([^/]+)$/.exec(route);
      if (diff) return deps.allows(token, diff[1] ?? "", "contents", "read") ? compare(diff[1] ?? "", diff[2] ?? "", diff[3] ?? "") : forbidden();
      const found = /^(GET|POST|PATCH|DELETE) \/repos\/([^/]+\/[^/]+)\/git\/(blobs|trees|commits|refs\/heads|ref\/heads)(?:\/([^?]+))?(?:\?.*)?$/.exec(route);
      if (!found) return null;
      const [, method = "", repo = "", what = "", rest = ""] = found;
      if (!deps.allows(token, repo, "contents", method === "GET" ? "read" : "write")) return forbidden();
      return git(method, repo, what, rest, body);
    },
  };
}
