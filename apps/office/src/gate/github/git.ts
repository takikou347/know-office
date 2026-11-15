// ワークスペースからの GitHub への要求を受ける。git は読むか push かを決め、送られた ref を見てから、絞った 1 時間の鍵を付けて送る。api.github.com は選んだリポジトリへの GET だけを通す (タスクとレビューの 3.3)
import { AppError, allowedFetch, decideRepo, recordedText, RepoName } from "@know-office/core";
import type { Context } from "hono";
import { endpoints } from "../endpoints.ts";
import type { GateEnv } from "../env.ts";
import { UNCONNECTED_DEPS } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { auditFrom } from "../ledger/record.ts";
import { findNode } from "../work/nodes.ts";
import type { TicketClaims } from "../work/ticket.ts";
import { githubToken } from "./app.ts";
import type { Permissions } from "./forge.ts";
import { repoScope } from "./rules.ts";

/** push の本文の上限 (100MB)。GitHub が 1 回の push に受ける上限に合わせる */
export const PUSH_BODY_BYTES = 100 * 1024 * 1024;
/** git の道。/{owner}/{name}.git/ の後ろに、ref の一覧か、読むか push */
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** GitHub に引き継ぐ git の要求のヘッダー。作業トークンは引き継がない */
const GIT_HEADERS = ["content-type", "accept", "git-protocol", "content-encoding"] as const;
/** 何も無い sha。ref を消す命令の後ろの値 */
const ZERO_SHA = "0".repeat(40);

/** push で変える ref の 1 つ */
export type RefUpdate = { from: string; to: string; ref: string };

/**
 * push の本文の頭の pkt-line から、変える ref を読む。flush (0000) までが命令。Git の pack-protocol の決まり
 * @param body 本文
 * @returns 変える ref。形が違えば null
 */
export function readRefUpdates(body: Uint8Array): RefUpdate[] | null {
  const decoder = new TextDecoder();
  const updates: RefUpdate[] = [];
  let at = 0;
  for (;;) {
    if (at + 4 > body.length) return null;
    const length = Number.parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (Number.isNaN(length)) return null;
    if (length === 0) return updates;
    if (length < 4 || at + length > body.length) return null;
    const line = decoder.decode(body.subarray(at + 4, at + length)).split("\0")[0]?.replace(/\n$/, "") ?? "";
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) return null;
    updates.push({ from: match[1] ?? "", to: match[2] ?? "", ref: match[3] ?? "" });
    at += length;
  }
}

/**
 * push の命令を断る理由を返す。main を進める事、ref を消す事、ブランチでない ref を変える事を断る
 * @param updates 変える ref
 * @returns 断る理由。通すなら null
 */
function refusedRef(updates: RefUpdate[]): string | null {
  if (updates.length === 0) return "変える ref が無い";
  for (const u of updates) {
    if (u.to === ZERO_SHA) return `ref を消す push: ${u.ref}`;
    if (!u.ref.startsWith("refs/heads/")) return `ブランチでない ref: ${u.ref}`;
    // main を進めるのはゲートウェイだけ (タスクとレビューの 3.4)
    if (u.ref === "refs/heads/main") return "main への push";
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

/**
 * 本文を上限まで読む
 * @param c 要求の文脈
 * @returns 本文
 * @throws payload_too_large 上限を超える時
 */
async function readBody(c: Context<GateEnv>): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(c.req.header("Content-Length") ?? "0") > PUSH_BODY_BYTES) throw new AppError("payload_too_large", "push が 100MB を超える");
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > PUSH_BODY_BYTES) throw new AppError("payload_too_large", "push が 100MB を超える");
  return body;
}

/**
 * ワークスペースの git の要求を、絞った鍵を付けて github.com に送る。push はタスクのリポジトリのブランチだけを通す
 * @param c 要求の文脈。作業トークンは受け手が確かめている
 * @param ticket 確かめた作業トークン
 * @returns GitHub の返事
 * @throws not_found git の道でない時
 * @throws rule_denied 触れるリポジトリでない、できない操作、タスクのでないリポジトリ、main や ref を消す push の時
 * @throws upstream_failed つないでいない、GitHub に届かない時
 */
export async function relayGit(c: Context<GateEnv>, ticket: TicketClaims): Promise<Response> {
  const url = new URL(c.req.url);
  const match = GIT_PATH.exec(url.pathname);
  const service = match?.[3] === "info/refs" ? url.searchParams.get("service") : match?.[3];
  const repo = RepoName.safeParse(match ? `${match[1] ?? ""}/${match[2] ?? ""}` : "");
  if (!match || !repo.success || (service !== "git-upload-pack" && service !== "git-receive-pack")) throw new AppError("not_found", "git の道でない");
  const push = service === "git-receive-pack";
  const scope = await repoScope(c.env.DB, repo.data);
  const decision = decideRepo({ action: push ? "push" : "read", repo: repo.data, paths: [] }, scope);
  if (!decision.allow) return deny(c, ticket, `${repo.data} ${push ? "push" : "read"}`, decision.reason);
  let body: Uint8Array<ArrayBuffer> | null = null;
  let refs: string[] = [];
  if (push) {
    // 書くのはタスクのリポジトリだけ。ほかのリポジトリはタスクの外
    const task = await findNode(c.env.DB, ticket.nodeId);
    if (task.repo !== repo.data) return deny(c, ticket, `${repo.data} push`, "タスクのリポジトリでない");
    if (c.req.method === "POST") {
      body = await readBody(c);
      const updates = readRefUpdates(body);
      if (!updates) throw new AppError("malformed_request", "push の命令の形が違う");
      const refused = refusedRef(updates);
      if (refused !== null) return deny(c, ticket, `${repo.data} push`, refused);
      refs = updates.map((u) => u.ref);
    }
  } else if (c.req.method === "POST") {
    body = await readBody(c);
  }
  const permissions: Permissions = { contents: push ? "write" : "read" };
  const token = await githubToken(c.env, c.var.github, repo.data, permissions);
  const root = `${endpoints(c.env).githubGit.replace(/\/$/, "")}/`;
  const headers = new Headers({ authorization: `Basic ${btoa(`x-access-token:${token.reveal()}`)}` });
  for (const name of GIT_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await allowedFetch(c.var.fetch, `${root}${repo.data}.git/${match[3] ?? ""}${url.search}`, [root], { method: c.req.method, headers, ...(body ? { body } : {}) });
  } catch {
    throw new AppError("upstream_failed", "GitHub に届かない");
  }
  if (push && c.req.method === "POST" && res.ok) {
    await auditFrom(c.env, { at: c.var.clock.now(), actor: ticket.staffId, action: "github.push", target: repo.data, scope: "office", detail: { nodeId: ticket.nodeId, refs }, traceId: c.var.traceId });
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" } });
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
 * @throws rule_denied GET でない、リポジトリの道でない、触れるリポジトリでない時
 * @throws upstream_failed つないでいない、GitHub に届かない時
 */
export async function relayGitHubApi(c: Context<GateEnv>, ticket: TicketClaims): Promise<Response> {
  const url = new URL(c.req.url);
  const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
  const repo = RepoName.safeParse(match?.[1] ?? "");
  if (c.req.method !== "GET") return deny(c, ticket, `api.github.com ${c.req.method}`, "書く操作は社員のツールで行う");
  if (!match || !repo.success) return deny(c, ticket, `api.github.com ${url.pathname}`, "リポジトリの道でない");
  const decision = decideRepo({ action: "read", repo: repo.data, paths: [] }, await repoScope(c.env.DB, repo.data));
  if (!decision.allow) return deny(c, ticket, `${repo.data} read`, decision.reason);
  const token = await githubToken(c.env, c.var.github, repo.data, readPermissions(match[2] ?? ""));
  const root = `${endpoints(c.env).github.replace(/\/$/, "")}/`;
  let res: Response;
  try {
    res = await allowedFetch(c.var.fetch, `${root}repos/${repo.data}${match[2] ?? ""}${url.search}`, [root], {
      headers: { authorization: `Bearer ${token.reveal()}`, accept: c.req.header("accept") ?? "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
  } catch {
    throw new AppError("upstream_failed", "GitHub に届かない");
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}
