// 監査ログのハッシュチェーンを書き、確かめる。書くのは記録 DO だけ (データの 3.3)
import type { D1Database } from "@cloudflare/workers-types";
import { type AuditInput, canonicalJson, type Clock, newId, sha256Hex } from "@know-office/core";

/** 最初の年の最初の行の prev_hash */
export const GENESIS_HASH = "0".repeat(64);

type HashedFields = { id: string; at: number; actor: string; action: string; target: string | null; scope: string; detail: unknown };

/**
 * 1 行のハッシュを計算する。prev_hash と中身を、キーを並べ替えた JSON にしてつなぐ
 * @param prevHash 前の行のハッシュ
 * @param row ハッシュに入れる項目
 * @returns 64 桁の 16 進数
 */
export function auditHash(prevHash: string, row: HashedFields): Promise<string> {
  return sha256Hex(prevHash + canonicalJson(row));
}

/**
 * 監査ログに 1 行足す。記録 DO の中で順に呼ぶ
 * @param db 書く年の REC_<年>
 * @param prevHash 前の行のハッシュ
 * @param input 頼まれた 1 件
 * @param clock ID を作る時刻
 * @returns 足した行の id と hash
 */
export async function appendAudit(db: D1Database, prevHash: string, input: AuditInput, clock: Clock): Promise<{ id: string; hash: string }> {
  const row: HashedFields = {
    id: newId(clock),
    at: input.at,
    actor: input.actor,
    action: input.action,
    target: input.target ?? null,
    scope: input.scope,
    detail: input.detail ?? null,
  };
  const hash = await auditHash(prevHash, row);
  await db
    .prepare("INSERT INTO audit_log (id, at, actor, action, target, scope, detail, prev_hash, hash, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.at, row.actor, row.action, row.target, row.scope, canonicalJson(row.detail), prevHash, hash, input.traceId ?? null)
    .run();
  return { id: row.id, hash };
}

/**
 * 最後の行のハッシュを読む。記録 DO が起き直した時だけ使う
 * @param db REC_<年>
 * @returns 最後の行のハッシュ。行が無ければ null
 */
export async function lastAuditHash(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1").first<{ hash: string }>();
  return row?.hash ?? null;
}

/** ハッシュチェーンを確かめた結果 */
export type ChainCheck = {
  /** 全部の行が合えば true */
  ok: boolean;
  /** 最初に合わなかった行の id。合えば null */
  brokenAt: string | null;
  /** 最後の行のハッシュ。行が無ければ始まりのハッシュ */
  lastHash: string;
};

type StoredRow = HashedFields & { detail: string; prev_hash: string; hash: string };

/**
 * 頭から順にハッシュを計算し直して確かめる
 * @param db REC_<年>
 * @param startHash その年の最初の行の prev_hash
 * @returns 合うか、最初に合わなかった行、最後のハッシュ
 */
export async function verifyChain(db: D1Database, startHash: string): Promise<ChainCheck> {
  const { results } = await db.prepare("SELECT id, at, actor, action, target, scope, detail, prev_hash, hash FROM audit_log ORDER BY rowid").all<StoredRow>();
  let prev = startHash;
  for (const row of results) {
    // detail は書いた時の canonicalJson の文なので、読み直して同じ形で計算し直すと書き換えが分かる
    const expected = await auditHash(prev, { id: row.id, at: row.at, actor: row.actor, action: row.action, target: row.target, scope: row.scope, detail: JSON.parse(row.detail) as unknown });
    if (row.prev_hash !== prev || row.hash !== expected) return { ok: false, brokenAt: row.id, lastHash: prev };
    prev = row.hash;
  }
  return { ok: true, brokenAt: null, lastHash: prev };
}
