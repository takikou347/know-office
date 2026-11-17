// ワークスペースからの GitHub への要求を受ける。git は読むか push かを決め、push の命令だけを読んで ref を見てから、絞った 1 時間の鍵を付けて送る。api.github.com は選んだリポジトリへの GET だけを通す (タスクとレビューの 3.3)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, allowedFetch, decideRepo, GitHubRepo, recordedText, RepoName } from "@know-office/core";
import type { Context } from "hono";
import { endpoints } from "../endpoints.ts";
import type { GateEnv } from "../env.ts";
import { ensureRunning } from "../guard/actions.ts";
import { UNCONNECTED_DEPS } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { auditFrom } from "../ledger/record.ts";
import { docsOf, mayPushDocs } from "../devloop/docs-link.ts";
import { findNode } from "../work/nodes.ts";
import type { TicketClaims } from "../work/ticket.ts";
import { callGitHub, GITHUB_USER_AGENT, githubRetryAfter, githubToken, isRedirect, parseGitHub } from "./app.ts";
import type { Permissions } from "./forge.ts";
import { noteGitHubRateLimit } from "./limits.ts";
import { repoScope } from "./rules.ts";

/** push の本文の上限 (100MB)。GitHub が 1 回の push に受ける上限に合わせる。gzip は解いた後の量で数える */
export const PUSH_BODY_BYTES = 100 * 1024 * 1024;
/** push の命令の部分の上限 (1MB)。flush までをここまでに読めなければ断る */
const COMMAND_BYTES = 1024 * 1024;
/** git の道。/{owner}/{name}.git/ の後ろに、ref の一覧か、読むか push */
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** GitHub に引き継ぐ git の要求のヘッダー。作業トークンは引き継がない。本文は解いて送るので content-encoding も引き継がない */
const GIT_HEADERS = ["content-type", "accept", "git-protocol"] as const;
/** GitHub の返事から社員に返すヘッダー。上限の待つ時刻だけを足し、要求の ID などは返さない */
const LIMIT_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-used", "x-ratelimit-resource"] as const;

/**
 * 中継で社員に返すヘッダーを作る。中身の種類と、上限の待つ時刻だけを写す
 * @param res GitHub の返事
 * @param contentType 中身の種類が無い時の物
 * @returns 返すヘッダー
 */
function relayedHeaders(res: Response, contentType: string): Headers {
  const headers = new Headers({ "content-type": res.headers.get("content-type") ?? contentType });
  for (const name of LIMIT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
/** 何も無い sha。ref を消す命令の後ろの値 */
const ZERO_SHA = "0".repeat(40);
/** push で変えてよい ref の形 */
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

/** push で変える ref の 1 つ */
export type RefUpdate = { from: string; to: string; ref: string };

/**
 * push の本文の頭の pkt-line から、変える ref を読む。shallow の行の後に命令が並び、flush (0000) までが命令。Git の pack-protocol の決まり
 * @param body 本文の頭
 * @returns 変える ref と命令の終わりの位置。形が違えば null、まだ足りなければ "more"
 */
export function readRefUpdates(body: Uint8Array): { updates: RefUpdate[]; end: number } | "more" | null {
  const decoder = new TextDecoder();
  const updates: RefUpdate[] = [];
  let at = 0;
  for (;;) {
    if (at + 4 > body.length) return "more";
    const head = decoder.decode(body.subarray(at, at + 4));
    // parseInt は符号や後ろの文字を読み飛ばすので、先に 16 進数 4 桁だけかを確かめる
    if (!/^[0-9a-f]{4}$/i.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) return { updates, end: at + 4 };
    if (length < 5) return null;
    if (at + length > body.length) return "more";
    const line = decoder.decode(body.subarray(at + 4, at + length)).split("\0")[0]?.replace(/\n$/, "") ?? "";
    at += length;
    // 浅い clone からの push は、命令の前に shallow の行を送る
    if (updates.length === 0 && /^shallow [0-9a-f]{40}$/.test(line)) continue;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) return null;
    updates.push({ from: match[1] ?? "", to: match[2] ?? "", ref: match[3] ?? "" });
  }
}

/**
 * push の命令を断る理由を返す。main と既定のブランチを進める事、ref を消す事、ブランチでない ref や崩れた名前の ref を変える事を断る
 * @param updates 変える ref
 * @param defaultBranch リポジトリの既定のブランチ
 * @returns 断る理由。通すなら null
 */
function refusedRef(updates: RefUpdate[], defaultBranch: string): string | null {
  if (updates.length === 0) return "変える ref が無い";
  for (const u of updates) {
    if (u.to === ZERO_SHA) return `ref を消す push: ${u.ref}`;
    if (!BRANCH_REF.test(u.ref)) return `ブランチでない ref: ${u.ref}`;
    if (u.ref.includes("//") || u.ref.includes("..") || u.ref.endsWith("/") || u.ref.endsWith(".lock")) return `崩れた ref: ${u.ref}`;
    const branch = u.ref.slice("refs/heads/".length).toLowerCase();
    // main と既定のブランチを進めるのはゲートウェイだけ (タスクとレビューの 3.4)。大文字の違いで別のブランチと見せさせない
    if (branch === "main" || branch === defaultBranch.toLowerCase()) return `${branch} への push`;
  }
  return null;
}

/**
 * ルールの外の操作として数え、断る
 * @param c 要求の文脈
 * @param ticket 確かめた作業トークン
 * @param target 相手
 * @param reason 理由
 * @returns 投げるので戻らない
 * @throws rule_denied いつも
 */
async function deny(c: Context<GateEnv>, ticket: TicketClaims, target: string, reason: string): Promise<never> {
  await observe(c.env, { type: "rule_denied", staffId: ticket.staffId, nodeId: ticket.nodeId, operation: "office.tool", target: recordedText(target) }, c.var.clock.now(), c.var.guard ?? UNCONNECTED_DEPS, c.var.traceId);
  throw new AppError("rule_denied", reason);
}

/** 流して送る本文。送った量が上限を超えたかを後で見る */
type Relayed = { stream: ReadableStream<Uint8Array>; over: () => boolean };

/**
 * 流れを書く口へ移す。読めない、壊れた gzip の失敗は書く口を切り、読む側の流れに出す
 * @param from 読む流れ
 * @param to 書く口
 */
async function pump(from: ReadableStream<Uint8Array>, to: WritableStreamDefaultWriter<BufferSource>): Promise<void> {
  const reader = from.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 型の上で書く口は ArrayBuffer の上の物だけを受けるので写す
      await to.write(new Uint8Array(value));
    }
    await to.close();
  } catch (error) {
    await to.abort(error).catch(() => undefined);
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * 本文を gzip なら解いて読む口にする
 * @param c 要求の文脈
 * @returns 解いた本文
 * @throws payload_too_large Content-Length が上限を超える時
 * @throws malformed_request gzip でない content-encoding の時
 */
function decodedBody(c: Context<GateEnv>): ReadableStream<Uint8Array> {
  if (Number(c.req.header("Content-Length") ?? "0") > PUSH_BODY_BYTES) throw new AppError("payload_too_large", "push が 100MB を超える");
  const encoding = (c.req.header("Content-Encoding") ?? "identity").trim().toLowerCase();
  const raw: ReadableStream<Uint8Array> = c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  if (encoding === "identity") return raw;
  if (encoding === "gzip") {
    const gunzip = new DecompressionStream("gzip");
    void pump(raw, gunzip.writable.getWriter());
    return gunzip.readable;
  }
  throw new AppError("malformed_request", "content-encoding は gzip だけを受ける");
}

/**
 * 先に読んだ頭と残りをつなぎ、送った量を数えて、上限を超えたら流れを切る
 * @param head 先に読んだ頭
 * @param rest 残りを読む口
 * @returns 流して送る本文
 */
function relayed(head: Uint8Array, rest: ReadableStreamDefaultReader<Uint8Array>): Relayed {
  const state = { sent: head.byteLength, over: head.byteLength > PUSH_BODY_BYTES, first: true };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (state.first) {
        state.first = false;
        if (head.byteLength > 0) {
          controller.enqueue(head);
          return;
        }
      }
      const { done, value } = await rest.read();
      if (done) {
        controller.close();
        return;
      }
      state.sent += value.byteLength;
      if (state.sent > PUSH_BODY_BYTES) {
        state.over = true;
        void rest.cancel();
        controller.error(new Error("push が 100MB を超える"));
        return;
      }
      controller.enqueue(value);
    },
    cancel: async () => rest.cancel(),
  });
  return { stream, over: () => state.over };
}

/**
 * push の本文から命令の部分だけを読み、残りは読まずに流す形にする
 * @param body 解いた本文
 * @returns 変える ref と流して送る本文
 * @throws malformed_request 命令の形が違う、flush で終わらない、flush までが 1MB を超える時
 */
async function readCommands(body: ReadableStream<Uint8Array>): Promise<{ updates: RefUpdate[]; relay: Relayed }> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  for (;;) {
    const parsed = readRefUpdates(head);
    if (parsed === null) throw new AppError("malformed_request", "push の命令の形が違う");
    if (parsed !== "more") return { updates: parsed.updates, relay: relayed(head, reader) };
    if (head.byteLength > COMMAND_BYTES) throw new AppError("malformed_request", "push の命令が長すぎる");
    const { done, value } = await reader.read();
    if (done) throw new AppError("malformed_request", "push の命令が flush で終わらない");
    const next = new Uint8Array(head.byteLength + value.byteLength);
    next.set(head);
    next.set(value, head.byteLength);
    head = next;
  }
}

/**
 * リポジトリの既定のブランチを読む
 * @param c 要求の文脈
 * @param repo リポジトリ
 * @param token 読める鍵
 * @returns 既定のブランチの名前
 * @throws upstream_failed 読めない、形が違う時。分からなければ push を通さない
 */
async function defaultBranchOf(c: Context<GateEnv>, repo: string, token: string): Promise<string> {
  const res = await callGitHub(c.env, c.var.fetch, `repos/${repo}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  return (await parseGitHub(res, GitHubRepo)).default_branch;
}

/**
 * 中継した GitHub の返事がレート制限なら、エラーログと通知に残す。返事はそのままワークスペースに返す
 * @param c 要求の文脈
 * @param res GitHub の返事
 */
async function noteRelayedLimit(c: Context<GateEnv>, res: Response): Promise<void> {
  const seconds = githubRetryAfter(res);
  if (seconds === null) return;
  await noteGitHubRateLimit(c.env, c.var.clock, { seconds, route: c.req.routePath, status: res.status, traceId: c.var.traceId });
}

/**
 * サービスのタスクが設計書のリポジトリへ push できる ref の見分けを作る。設計書の PR の行があればそのブランチだけ。行が無い最初の push は ko/<タスク ID の頭 8 字>- で始まるブランチだが、頭 8 字は同じ時に作ったタスクと重なりうるので、ほかのタスクの行のブランチと同じ名前は断る
 * @param db 今の状態の D1
 * @param task タスク
 * @param task.id タスク ID
 * @returns ref を受けるか見る関数
 */
async function ownDocsRef(db: D1Database, task: { id: string }): Promise<(ref: string) => Promise<boolean>> {
  const row = await docsOf(db, task.id);
  if (row !== null) return (ref) => Promise.resolve(ref === `refs/heads/${row.branch}`);
  const prefix = `refs/heads/ko/${task.id.slice(0, 8)}-`;
  return async (ref) => {
    if (!ref.startsWith(prefix)) return false;
    const taken = await db.prepare("SELECT 1 AS taken FROM task_docs WHERE branch = ? AND node_id <> ?").bind(ref.slice("refs/heads/".length), task.id).first();
    return taken === null;
  };
}

/**
 * ワークスペースの git の要求を、絞った鍵を付けて github.com に送る。push はタスクのリポジトリのブランチだけを通す。サービスのタスクだけは、設計書のリポジトリの自分のブランチにも push できる (設計書の PR の行があればそのブランチと同じ名前、出す前は ko/<タスク ID の頭 8 字>- で始まる名前。main と ref の削除は断る)。本文は命令だけを読み、残りは流して送る
 * @param c 要求の文脈。作業トークンは受け手が確かめている
 * @param ticket 確かめた作業トークン
 * @returns GitHub の返事
 * @throws not_found git の道でない時
 * @throws stopped 全体、社員、タスクが止まっている時
 * @throws rule_denied 触れるリポジトリでない、できない操作、タスクのでないリポジトリ、main や既定のブランチ、ref を消す、崩れた ref の push の時
 * @throws malformed_request push の命令の形が違う時
 * @throws payload_too_large 本文が 100MB を超える時
 * @throws upstream_failed つないでいない、GitHub に届かない時
 */
export async function relayGit(c: Context<GateEnv>, ticket: TicketClaims): Promise<Response> {
  const url = new URL(c.req.url);
  const match = GIT_PATH.exec(url.pathname);
  const service = match?.[3] === "info/refs" ? url.searchParams.get("service") : match?.[3];
  const repo = RepoName.safeParse(match ? `${match[1] ?? ""}/${match[2] ?? ""}` : "");
  if (!match || !repo.success || (service !== "git-upload-pack" && service !== "git-receive-pack")) throw new AppError("not_found", "git の道でない");
  // 全体、社員、タスクが止まっている間は、鍵を作らず GitHub へ出さない (自動停止の 3.3)
  await ensureRunning(c.env, ticket.staffId, ticket.nodeId);
  const push = service === "git-receive-pack";
  const scope = await repoScope(c.env.DB, repo.data);
  const decision = decideRepo({ action: push ? "push" : "read", repo: repo.data, paths: [] }, scope);
  if (!decision.allow) return deny(c, ticket, `${repo.data} ${push ? "push" : "read"}`, decision.reason);
  // 書くのはタスクのリポジトリだけ。ほかのリポジトリはタスクの外
  // ただしサービスのタスクは、設計書のリポジトリの自分のタスクのブランチにも書ける。同じ時に設計書を直す (開発の回し方の 3.6)。設計書の PR の行があればそのブランチだけ、無い最初の push は ko/<タスク ID の頭 8 字>- で始まり、ほかのタスクの行のブランチと重ならない名前
  const task = push ? await findNode(c.env.DB, ticket.nodeId) : null;
  const docsRef = task !== null && task.repo !== repo.data && (await mayPushDocs(c.env.DB, task, repo.data)) ? await ownDocsRef(c.env.DB, task) : null;
  if (task !== null && task.repo !== repo.data && docsRef === null) return deny(c, ticket, `${repo.data} push`, "タスクのリポジトリでない");
  const body = c.req.method === "POST" ? decodedBody(c) : null;
  const commands = push && body ? await readCommands(body) : null;
  const token = await githubToken(c.env, c.var.github, repo.data, { contents: push ? "write" : "read" });
  if (commands) {
    const own = docsRef !== null && !(await Promise.all(commands.updates.map((u) => docsRef(u.ref)))).every(Boolean) ? "設計書のリポジトリは自分のタスクのブランチだけ" : null;
    const refused = own ?? refusedRef(commands.updates, await defaultBranchOf(c, repo.data, token.reveal()));
    if (refused !== null) {
      void commands.relay.stream.cancel();
      return deny(c, ticket, `${repo.data} push`, refused);
    }
  }
  const relay = commands?.relay ?? (body ? relayed(new Uint8Array(0), body.getReader()) : null);
  const root = `${endpoints(c.env).githubGit.replace(/\/$/, "")}/`;
  const headers = new Headers({ authorization: `Basic ${btoa(`x-access-token:${token.reveal()}`)}`, "user-agent": GITHUB_USER_AGENT });
  for (const name of GIT_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  // 流れの本文は duplex を要る所がある
  // 追った先に鍵を送らないよう、リダイレクトは追わない
  const init: RequestInit & { duplex?: "half" } = { method: c.req.method, headers, redirect: "manual", ...(relay ? { body: relay.stream, duplex: "half" } : {}) };
  let res: Response | null = null;
  try {
    res = await allowedFetch(c.var.fetch, `${root}${repo.data}.git/${match[3] ?? ""}${url.search}`, [root], init);
  } catch {
    res = null;
  }
  if (relay?.over()) throw new AppError("payload_too_large", "push が 100MB を超える");
  const status = res?.status ?? 502;
  // 読む操作も push も、失敗も含めて App を通した操作として残す (タスクとレビューの 3.3)
  const entry = commands
    ? { action: "github.push", detail: { nodeId: ticket.nodeId, refs: commands.updates.map((u) => recordedText(u.ref)), status } }
    : { action: "github.read", detail: { nodeId: ticket.nodeId, via: "git", path: match[3] ?? "", status } };
  await auditFrom(c.env, { at: c.var.clock.now(), actor: ticket.staffId, target: repo.data, scope: "office", traceId: c.var.traceId, ...entry });
  if (!res) throw new AppError("upstream_failed", "GitHub に届かない");
  await noteRelayedLimit(c, res);
  if (isRedirect(res)) throw new AppError("upstream_failed", "GitHub がリダイレクトを返した");
  return new Response(res.body, { status: res.status, headers: relayedHeaders(res, "application/octet-stream") });
}

/**
 * GET の道から要る権限を決める。読む権限だけを付ける
 * @param rest /repos/{o}/{r} より後ろの道
 * @returns 権限
 */
function readPermissions(rest: string): Permissions {
  if (/^\/pulls(\/|$)/.test(rest)) return { pull_requests: "read" };
  if (/^\/issues(\/|$)/.test(rest)) return { issues: "read" };
  if (/\/(check-runs|check-suites)(\/|$)/.test(rest)) return { checks: "read" };
  if (/\/(status|statuses)(\/|$)/.test(rest)) return { statuses: "read" };
  return { contents: "read" };
}

/**
 * ワークスペースからの api.github.com を、選んだリポジトリへの GET だけ、読む鍵を付けて送る。書く操作は社員のツールで行う
 * @param c 要求の文脈。作業トークンは受け手が確かめている
 * @param ticket 確かめた作業トークン
 * @returns GitHub の返事
 * @throws stopped 全体、社員、タスクが止まっている時
 * @throws rule_denied GET でない、リポジトリの道でない、触れるリポジトリでない時
 * @throws upstream_failed つないでいない、GitHub に届かない時
 */
export async function relayGitHubApi(c: Context<GateEnv>, ticket: TicketClaims): Promise<Response> {
  await ensureRunning(c.env, ticket.staffId, ticket.nodeId);
  const url = new URL(c.req.url);
  const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
  const repo = RepoName.safeParse(match?.[1] ?? "");
  if (c.req.method !== "GET") return deny(c, ticket, `api.github.com ${c.req.method}`, "書く操作は社員のツールで行う");
  if (!match || !repo.success) return deny(c, ticket, `api.github.com ${url.pathname}`, "リポジトリの道でない");
  const decision = decideRepo({ action: "read", repo: repo.data, paths: [] }, await repoScope(c.env.DB, repo.data));
  if (!decision.allow) return deny(c, ticket, `${repo.data} read`, decision.reason);
  const token = await githubToken(c.env, c.var.github, repo.data, readPermissions(match[2] ?? ""));
  const root = `${endpoints(c.env).github.replace(/\/$/, "")}/`;
  let res: Response | null = null;
  try {
    res = await allowedFetch(c.var.fetch, `${root}repos/${repo.data}${match[2] ?? ""}${url.search}`, [root], {
      headers: { authorization: `Bearer ${token.reveal()}`, accept: c.req.header("accept") ?? "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": GITHUB_USER_AGENT },
      redirect: "manual",
    });
  } catch {
    res = null;
  }
  await auditFrom(c.env, {
    at: c.var.clock.now(),
    actor: ticket.staffId,
    action: "github.read",
    target: repo.data,
    scope: "office",
    detail: { nodeId: ticket.nodeId, via: "api", path: recordedText(match[2] ?? ""), status: res?.status ?? 502 },
    traceId: c.var.traceId,
  });
  if (!res) throw new AppError("upstream_failed", "GitHub に届かない");
  await noteRelayedLimit(c, res);
  if (isRedirect(res)) throw new AppError("upstream_failed", "GitHub がリダイレクトを返した");
  return new Response(res.body, { status: res.status, headers: relayedHeaders(res, "application/json") });
}
