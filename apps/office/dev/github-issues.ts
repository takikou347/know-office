// 開発環境の代わりの GitHub のうち、Issue の一覧、作成、更新、コメント、sub-issue に答える所。GitHub の決まりのうち know-office が当たる所 (頁の上限、ID と番号の違い、sub-issue の 100 件、content creation の 1 分 80 件) を同じに持つ
import { z } from "zod";

/** 代わりの GitHub に置いた Issue 1 件 */
export type FakeIssue = {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  /** プルリクエストなら true。GitHub の Issue の一覧にはプルリクエストも出る */
  pull: boolean;
  /** 親の Issue の番号 */
  parent: number | null;
  comments: { id: number; body: string }[];
};

/** 代わりの GitHub が Issue のために持つ物 */
export type IssuesDeps = {
  /** 鍵がリポジトリへの権限を持つか */
  allows(token: string | null, repo: string, name: string, level: "read" | "write"): boolean;
  /** 続き番号 */
  next(): number;
  /** 今の時刻 */
  now(): number;
};

/** Issue の代わり。items はリポジトリごとの Issue、creates は content creation の時刻、answer は要求に答える */
export type FakeIssues = {
  /** リポジトリごとの Issue。番号の順 */
  items: Map<string, FakeIssue[]>;
  /** 受けた書きの要求。「メソッド 道」の順 */
  writes: string[];
  /** Issue を足す。テストが前から GitHub にある Issue を置く時 */
  seed(repo: string, issue: Partial<FakeIssue> & { title: string }): FakeIssue;
  /** 要求に答える。当たらなければ null */
  answer(route: string, text: string, token: string | null, query: URLSearchParams): Response | null;
};

/** content creation の上限 (1 分に 80 件)。GitHub の Rate limits for the REST API */
export const CONTENT_PER_MINUTE = 80;

/** 1 つの親に付けられる sub-issue の上限。GitHub の Adding sub-issues */
export const SUB_ISSUES_MAX = 100;

const CreateRequest = z.object({ title: z.string().min(1), body: z.string().optional(), labels: z.array(z.string()).optional() }).loose();
const UpdateRequest = z.object({ state: z.enum(["open", "closed"]), state_reason: z.enum(["completed", "not_planned", "reopened", "duplicate"]).optional() }).loose();
const CommentRequest = z.object({ body: z.string().min(1) }).loose();
const SubRequest = z.object({ sub_issue_id: z.number().int(), replace_parent: z.boolean().optional() }).loose();

const forbidden = () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
const invalid = (message = "Validation Failed") => Response.json({ message }, { status: 422 });

/**
 * 頁を切って返す。per_page は 100 まで。GitHub は 100 を超える値を 100 にする
 * @param all 全部
 * @param query クエリ
 * @returns 返事
 */
function page(all: unknown[], query: URLSearchParams): Response {
  const per = Math.min(Number(query.get("per_page") ?? "30") || 30, 100);
  const n = Math.max(Number(query.get("page") ?? "1") || 1, 1);
  return Response.json(all.slice((n - 1) * per, n * per));
}

/**
 * Issue の代わりを作る
 * @param deps 代わりの GitHub の中身
 * @returns Issue の置き場と、答える口
 */
export function createFakeIssues(deps: IssuesDeps): FakeIssues {
  const items = new Map<string, FakeIssue[]>();
  const writes: string[] = [];
  const creates: number[] = [];
  /**
   * 番号から Issue を探す。番号はリポジトリごと、ID は全体で続く
   * @param repo リポジトリ
   * @param number 番号
   * @returns Issue。無ければ undefined
   */
  const find = (repo: string, number: number): FakeIssue | undefined => items.get(repo)?.find((i) => i.number === number);

  const seed: FakeIssues["seed"] = (repo, issue) => {
    const list = items.get(repo) ?? [];
    const made: FakeIssue = { number: list.length + 1, id: 9000 + deps.next(), body: null, state: "open", stateReason: null, labels: [], pull: false, parent: null, comments: [], ...issue };
    items.set(repo, [...list, made]);
    return made;
  };

  /**
   * 1 分に 80 件の content creation の上限を数える。超えたら GitHub と同じく 403 と Retry-After で断る
   * @returns 断る返事。通せば null
   */
  const limited = (): Response | null => {
    const now = deps.now();
    while (creates.length > 0 && now - (creates[0] ?? 0) >= 60_000) creates.shift();
    if (creates.length >= CONTENT_PER_MINUTE) return Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403, headers: { "retry-after": "60" } });
    creates.push(now);
    return null;
  };

  /**
   * Issue の JSON の形にする
   * @param i Issue
   * @returns JSON
   */
  const json = (i: FakeIssue) => ({
    number: i.number,
    id: i.id,
    title: i.title,
    body: i.body,
    state: i.state,
    state_reason: i.stateReason,
    labels: i.labels.map((name) => ({ name })),
    ...(i.pull ? { pull_request: { url: "x" } } : {}),
  });

  return {
    items,
    writes,
    seed,
    answer: (route, text, token, query) => {
      const found = /^(GET|POST|PATCH) \/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(?:\/(comments|sub_issues))?)?$/.exec(route);
      if (!found) return null;
      const [, method = "", repo = "", num, sub] = found;
      const write = method !== "GET";
      if (!deps.allows(token, repo, "issues", write ? "write" : "read")) return forbidden();
      if (write) writes.push(route);
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        return invalid("Problems parsing JSON");
      }
      if (num === undefined) {
        if (method === "GET") {
          const state = query.get("state") ?? "open";
          const all = (items.get(repo) ?? []).filter((i) => state === "all" || i.state === state);
          return page((query.get("direction") === "asc" ? all : all.toReversed()).map(json), query);
        }
        const input = CreateRequest.safeParse(body);
        if (method !== "POST" || !input.success) return invalid();
        const limit = limited();
        if (limit) return limit;
        const made = seed(repo, { title: input.data.title, body: input.data.body ?? null, labels: input.data.labels ?? [] });
        return Response.json(json(made), { status: 201 });
      }
      const issue = find(repo, Number(num));
      if (!issue) return Response.json({ message: "Not Found" }, { status: 404 });
      if (sub === "comments") {
        if (method === "GET") return page(issue.comments, query);
        const input = CommentRequest.safeParse(body);
        if (!input.success) return invalid();
        const limit = limited();
        if (limit) return limit;
        const comment = { id: 7000 + deps.next(), body: input.data.body };
        issue.comments.push(comment);
        return Response.json(comment, { status: 201 });
      }
      if (sub === "sub_issues") {
        if (method === "GET") return page((items.get(repo) ?? []).filter((i) => i.parent === issue.number).map(json), query);
        const input = SubRequest.safeParse(body);
        if (!input.success) return invalid();
        // sub_issue_id は番号でなく ID。同じリポジトリの Issue だけを探す
        const child = (items.get(repo) ?? []).find((i) => i.id === input.data.sub_issue_id);
        if (!child) return Response.json({ message: "Not Found" }, { status: 404 });
        const limit = limited();
        if (limit) return limit;
        if (child.number === issue.number) return invalid();
        // すでに子なら、同じ親でも別の親でも 422。replace_parent が true の時だけ別の親から移す
        if (child.parent !== null && !(input.data.replace_parent === true && child.parent !== issue.number)) return invalid("Sub-issue already has a parent");
        if ((items.get(repo) ?? []).filter((i) => i.parent === issue.number).length >= SUB_ISSUES_MAX) return invalid("Parent has too many sub-issues");
        child.parent = issue.number;
        return Response.json(json(issue), { status: 201 });
      }
      if (method === "GET") return Response.json(json(issue));
      const input = UpdateRequest.safeParse(body);
      if (method !== "PATCH" || !input.success) return invalid();
      issue.state = input.data.state;
      issue.stateReason = input.data.state_reason ?? null;
      return Response.json(json(issue));
    },
  };
}
