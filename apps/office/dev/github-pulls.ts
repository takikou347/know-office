// 開発環境の代わりの GitHub のうち、プルリクエストのレビューと行のコメント、Git の API (blobs、trees、commits、ブランチの先) に答える所。GitHub の決まりのうち know-office が当たる所だけを持つ
import { z } from "zod";

/** プルリクエストのレビューを出す要求。GitHub の POST /repos/{o}/{r}/pulls/{n}/reviews */
const ReviewRequest = z.object({ event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional(), commit_id: z.string().optional() }).loose();
/** 行のコメントを出す要求。GitHub の POST /repos/{o}/{r}/pulls/{n}/comments */
const CommentRequest = z.object({ body: z.string().min(1), commit_id: z.string(), path: z.string().min(1), line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]) }).loose();
/** Git の API の要求のうち使う所 */
const BlobRequest = z.object({ content: z.string(), encoding: z.enum(["utf-8", "base64"]) }).loose();
const TreeRequest = z.object({ base_tree: z.string(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: z.string() }).loose()) }).loose();
const CommitRequest = z.object({ message: z.string(), tree: z.string(), parents: z.array(z.string()) }).loose();
const RefRequest = z.object({ sha: z.string(), force: z.boolean().optional() }).loose();

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
  /** 受けたレビューと行のコメントの後に GitHub が送る通知 */
  sent: { event: string; payload: unknown }[];
  /** ブランチの先のコミット。「owner/name:ブランチ」から */
  heads: Map<string, string>;
};

/** レビューと Git の API の代わり */
export type FakePulls = {
  /** プルリクエストを出した者を覚える */
  opened(repo: string, number: number, token: string | null): void;
  /** 要求に答える。当たらなければ null */
  answer(route: string, text: string, token: string | null): Response | null;
};

const invalid = () => Response.json({ message: "Invalid request" }, { status: 422 });
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
      return Response.json(review);
    }
    const input = CommentRequest.safeParse(body);
    if (!input.success) return invalid();
    const comment = { id, body: input.data.body, path: input.data.path, line: input.data.line, side: input.data.side, commit_id: input.data.commit_id, user, author_association: "NONE" };
    deps.sent.push({ event: "pull_request_review_comment", payload: { action: "created", comment, ...head } });
    return Response.json(comment, { status: 201 });
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

  return {
    opened: (repo, number, token) => void authors.set(`${repo}#${String(number)}`, deps.actorOf(token).key),
    answer: (route, text, token) => {
      const body: unknown = text ? JSON.parse(text) : null;
      const review = /^POST \/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/(reviews|comments)$/.exec(route);
      if (review) return pull(review[1] ?? "", Number(review[2]), review[3] ?? "", body, token);
      const found = /^(GET|POST|PATCH) \/repos\/([^/]+\/[^/]+)\/git\/(blobs|trees|commits|refs\/heads)(?:\/(.+))?$/.exec(route);
      if (!found) return null;
      const [, method = "", repo = "", what = "", rest = ""] = found;
      if (!deps.allows(token, repo, "contents", method === "GET" ? "read" : "write")) return forbidden();
      return git(method, repo, what, rest, body);
    },
  };
}
