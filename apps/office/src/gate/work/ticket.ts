// 作業トークンを vault の ticket_key で署名して発行し、確かめ、チェックポイントで発行し直す (社員が考えるの 2 章、3.2、3.3)
import { AppError, type Clock, log, type StaffId, WorkTicketClaims } from "@know-office/core";
import { compactVerify, SignJWT } from "jose";
import { vaultKey } from "../auth/vault.ts";
import type { Bindings } from "../env.ts";
import { staffOf } from "../guard/actions.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe, verifyWorkToken } from "../guard/observe.ts";

/** 作業トークンの JWT の typ。ほかの用途の JWT と取り違えない */
export const TICKET_TYP = "ko-ticket+jwt";
/** 作業トークンの署名のアルゴリズム。これ以外は断る (API の決まりの 3.6 の 3) */
export const TICKET_ALG = "HS256";

/** 作業トークンを確かめて分かった事。時刻は協定世界時のミリ秒 */
export type TicketClaims = {
  /** 社員 ID */
  staffId: StaffId;
  /** タスク ID */
  nodeId: string;
  /** 発行した先のワークスペース ID */
  workspaceId: string;
  /** 作業トークン ID */
  jti: string;
  /** 期限 */
  expiresAt: number;
};

/** 要求を送ったワークスペース。コンテナの外向きの通信の受け手が、送ったコンテナから決める */
export type Caller = {
  /** そのワークスペースの社員 */
  staffId: StaffId;
  /** そのワークスペースの ID */
  workspaceId: string;
};

/**
 * 社員のワークスペースの ID を返す。ワークスペースのコンテナの DO の ID で、作業トークンの ws に入る
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns ワークスペース ID
 */
export function workspaceIdOf(env: Bindings, staffId: StaffId): string {
  return env.WORKSPACE.idFromName(staffId).toString();
}

/**
 * 署名の鍵を読む。全体を止めて取り替えると、前の鍵で署名した物は使えなくなる
 * @param env バインディング
 * @param clock 時刻
 * @returns HS256 の鍵
 */
async function ticketKey(env: Bindings, clock: Clock): Promise<Uint8Array<ArrayBuffer>> {
  return vaultKey(env.DB, "ticket_key", env.MASTER_KEY, clock);
}

/**
 * 監査ログに 1 行頼む。作業トークンそのものは入れない
 * @param env バインディング
 * @param at 時刻
 * @param action ticket.issue か ticket.revoke
 * @param staffId 社員 ID
 * @param jti 作業トークン ID
 * @param detail 中身
 */
async function record(env: Bindings, at: number, action: "ticket.issue" | "ticket.revoke", staffId: StaffId, jti: string, detail: Record<string, string | number>): Promise<void> {
  const recorder = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
  await recorder.append({ at, actor: "system", action, target: jti, scope: "office", detail: { staffId, ...detail } });
}

/**
 * 署名した作業トークンを作る
 * @param env バインディング
 * @param claims 中身
 * @param issuedAt 発行した時刻
 * @returns JWT
 */
async function sign(env: Bindings, claims: TicketClaims, issuedAt: number): Promise<string> {
  return new SignJWT({ node: claims.nodeId, ws: claims.workspaceId })
    .setProtectedHeader({ alg: TICKET_ALG, typ: TICKET_TYP })
    .setSubject(claims.staffId)
    .setJti(claims.jti)
    .setIssuedAt(Math.floor(issuedAt / 1000))
    // StaffDO の一覧の期限と同じ。秒に切り捨てて、一覧より先に切れる側にそろえる
    .setExpirationTime(Math.floor(claims.expiresAt / 1000))
    .sign(await ticketKey(env, { now: () => issuedAt }));
}

/**
 * タスクの作業トークンを発行する。StaffDO の有効な一覧に足し、vault の ticket_key で署名し、監査ログに残す
 * @param env バインディング
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @param now 今の時刻
 * @returns 作業トークン、ID、期限
 */
export async function issueTicket(env: Bindings, staffId: StaffId, nodeId: string, now: number): Promise<{ token: string; jti: string; expiresAt: number }> {
  const workspaceId = workspaceIdOf(env, staffId);
  const { jti, expiresAt } = await staffOf(env, staffId).issueToken(nodeId, workspaceId, now);
  const token = await sign(env, { staffId, nodeId, workspaceId, jti, expiresAt }, now);
  await record(env, now, "ticket.issue", staffId, jti, { nodeId, expiresAt });
  return { token, jti, expiresAt };
}

/**
 * 作業トークンの署名と形だけを確かめ、中身を返す
 * @param env バインディング
 * @param token 作業トークン
 * @param now 今の時刻
 * @returns 中身
 * @throws unauthenticated 署名が合わない、アルゴリズムか typ か形が違う時
 */
async function verified(env: Bindings, token: string, now: number): Promise<WorkTicketClaims> {
  try {
    // alg は HS256 だけを受ける。HMAC の比べは crypto.subtle.verify が一定の時間で行う
    const { payload, protectedHeader } = await compactVerify(token, await ticketKey(env, { now: () => now }), { algorithms: [TICKET_ALG] });
    if (protectedHeader.typ !== TICKET_TYP) throw new Error("typ が違う");
    return WorkTicketClaims.parse(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    throw new AppError("unauthenticated", "作業トークンの署名か形が違う");
  }
}

/**
 * 作業トークンを確かめる。署名、発行した先、期限、StaffDO の有効な一覧の順に見る
 * 署名の合う作業トークンが発行した先と違うワークスペースから来たら、期限が切れていても横取りとして全体を止める
 * @param env バインディング
 * @param token 作業トークン
 * @param caller 送ったワークスペース
 * @param now 今の時刻
 * @param deps 自動停止が外へ頼む口
 * @returns 中身
 * @throws unauthenticated 署名が合わない、期限切れ、失効した、発行した先と違う時
 */
export async function authenticateTicket(env: Bindings, token: string, caller: Caller, now: number, deps: GuardDeps): Promise<TicketClaims> {
  const claims = await verified(env, token, now);
  if (claims.ws !== caller.workspaceId || claims.sub !== caller.staffId) {
    await observe(env, { type: "ticket_misuse", staffId: claims.sub, jti: claims.jti, workspaceId: caller.workspaceId }, now, deps);
    throw new AppError("unauthenticated", "作業トークンが使えない");
  }
  const expiresAt = claims.exp * 1000;
  if (expiresAt <= now) throw new AppError("unauthenticated", "作業トークンの期限が切れた");
  await verifyWorkToken(env, claims.sub, claims.jti, caller.workspaceId, now, deps);
  return { staffId: claims.sub, nodeId: claims.node, workspaceId: claims.ws, jti: claims.jti, expiresAt };
}

/**
 * チェックポイントで、残りが 10 分を切った作業トークンを発行し直してワークスペースに渡す。渡し終えたら前の作業トークンを失効させる
 * 渡せない時は前の作業トークンを残し、次のチェックポイントでもう一度渡す
 * @param env バインディング
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @param now 今の時刻
 * @returns 渡したか
 */
export async function renewTicket(env: Bindings, staffId: StaffId, nodeId: string, now: number): Promise<boolean> {
  const workspaceId = workspaceIdOf(env, staffId);
  const staff = staffOf(env, staffId);
  const renewed = await staff.renewToken(nodeId, workspaceId, now);
  if (!renewed) return false;
  const token = await sign(env, { staffId, nodeId, workspaceId, jti: renewed.jti, expiresAt: renewed.expiresAt }, now);
  await record(env, now, "ticket.issue", staffId, renewed.jti, { nodeId, expiresAt: renewed.expiresAt });
  try {
    await env.WORKSPACE.get(env.WORKSPACE.idFromName(staffId)).replaceTicket(token);
  } catch (error) {
    // 渡せなかった新しい作業トークンは使われないので失効させ、前の作業トークンで続ける
    await staff.revokeTokens([renewed.jti]);
    log("warn", "ticket_renew_failed", { staffId, nodeId, error: error instanceof Error ? error.message : "unknown" });
    return false;
  }
  await staff.revokeTokens(renewed.replaces);
  for (const jti of renewed.replaces) await record(env, now, "ticket.revoke", staffId, jti, { nodeId, reason: "renewed" });
  return true;
}
