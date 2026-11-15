// 会話の記録をタスクごとの鍵の AES-GCM で暗号にして R2 に置き、ワークスペースが落ちて作り直した後に復号して戻し、同じ session の続きを呼ぶ (社員が考えるの 3.6)
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { AppError, deriveKey, fromBase64, log, newId, RESTORE_TRANSCRIPT_BYTES, type RestoreInput, ROLE_TOOLS, RunInput, type StaffId, toBase64, TranscriptPartInput } from "@know-office/core";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { nodes, staff, staffPrompts, transcriptParts } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { staffOf } from "../guard/actions.ts";
import { clockAt } from "./attendance.ts";
import { issueTicket, retireOtherTickets } from "./ticket.ts";

/** 会話の記録の置き場。社員 DO だけが持つ */
export type TranscriptStore = {
  /** 今の状態の D1。transcript_parts に部分ごとの行を足す */
  db: D1Database;
  /** 暗号にした部分を置く R2 */
  files: R2Bucket;
  /** MASTER_KEY。タスクごとの鍵を作る */
  master: string;
  /** 戻す記録の全部の上限。省くと RESTORE_TRANSCRIPT_BYTES。テストは小さくして試す */
  maxBytes?: number;
};

/** AES-GCM の iv の長さ。置く物の頭に付ける */
const IV_BYTES = 12;
/** 置く物が元より増える長さ。iv と、AES-GCM の 16 バイトの認証タグ */
const SEAL_OVERHEAD = IV_BYTES + 16;

/** 落ちた後に続きから呼ぶ時の指示。最初の指示は会話の記録に残っているので繰り返さない */
export const RESUME_PROMPT = "ワークスペースが落ちて作り直したので、会話の記録から続きを呼び直した。最後のチェックポイントより後の作業はリポジトリに残っていないかもしれないので、リポジトリの状態を確かめ直してから続ける";

/** タスクの種類ごとの考える深さ。作るタスクは medium、見るタスクは high。ここに無い種類は社員の初期値を使う (社員が考えるの 3.3) */
const EFFORT_BY_KIND: Partial<Record<string, RunInput["effort"]>> = { build: "medium", fix: "medium", content: "medium", review: "high" };

/**
 * 部分を置く R2 の道を返す
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @param sessionId SDK の session
 * @param seq 通し番号
 * @returns transcripts/<社員>/<タスク>/<session>/<seq>.bin
 */
export function transcriptPath(staffId: StaffId, nodeId: string, sessionId: string, seq: number): string {
  return `transcripts/${staffId}/${nodeId}/${sessionId}/${String(seq)}.bin`;
}

/**
 * 部分を暗号にする。置き場の道を追加の認証データに入れ、ほかの置き場やタスクへ移した物を戻せなくする
 * @param master MASTER_KEY
 * @param nodeId タスク ID。鍵をタスクごとに分ける
 * @param path 置き場の道
 * @param plain 元のバイト列
 * @returns iv と暗号文をつないだ物
 */
async function seal(master: string, nodeId: string, path: string, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await deriveKey(master, "transcript", nodeId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(path) }, key, plain));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return out;
}

/**
 * 部分を復号する
 * @param master MASTER_KEY
 * @param nodeId タスク ID
 * @param path 置き場の道
 * @param stored iv と暗号文をつないだ物
 * @returns 元のバイト列
 * @throws internal 戻せない時
 */
async function unseal(master: string, nodeId: string, path: string, stored: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await deriveKey(master, "transcript", nodeId);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: stored.slice(0, IV_BYTES), additionalData: new TextEncoder().encode(path) }, key, stored.slice(IV_BYTES));
    return new Uint8Array(plain);
  } catch {
    // 中身も鍵も記録の文に入れない
    throw new AppError("internal", "会話の記録を戻せない");
  }
}

/**
 * 置いた部分を復号し、送られた中身と同じかを比べる
 * @param store 置き場
 * @param nodeId タスク ID
 * @param path 置き場の道
 * @param plain 送られた中身
 * @returns 同じなら true。置いた物が無ければ false
 * @throws internal 置いた物を戻せない時
 */
async function sameAs(store: TranscriptStore, nodeId: string, path: string, plain: Uint8Array): Promise<boolean> {
  const object = await store.files.get(path);
  if (!object) return false;
  const stored = await unseal(store.master, nodeId, path, new Uint8Array(await object.arrayBuffer()));
  return stored.byteLength === plain.byteLength && stored.every((byte, i) => byte === plain[i]);
}

/**
 * 会話の記録の続きを、タスクごとの鍵で暗号にして R2 に置き、transcript_parts に 1 行足す。社員 DO の鎖の中で呼び、同じ session の部分を 1 つずつ足す
 * @param store 置き場
 * @param staffId 社員 ID
 * @param nodeId タスク ID。作業トークンから読む
 * @param input TranscriptPartInput
 * @param now 今の時刻
 * @throws validation_failed 形が違う時
 * @throws conflict 通し番号が前回の続きでない時と、前回と同じ通し番号で中身が違う時
 */
export async function appendTranscript(store: TranscriptStore, staffId: StaffId, nodeId: string, input: unknown, now: number): Promise<void> {
  const parsed = TranscriptPartInput.safeParse(input);
  if (!parsed.success) throw new AppError("validation_failed", "会話の記録の形が違う");
  const { sessionId, seq, chunk } = parsed.data;
  const orm = drizzle(store.db);
  const [last] = await orm
    .select({ seq: transcriptParts.seq, key: transcriptParts.key })
    .from(transcriptParts)
    .where(and(eq(transcriptParts.staffId, staffId), eq(transcriptParts.nodeId, nodeId), eq(transcriptParts.sessionId, sessionId)))
    .orderBy(desc(transcriptParts.seq))
    .limit(1);
  const plain = fromBase64(chunk);
  if (!plain) throw new AppError("validation_failed", "会話の記録の形が違う");
  // 返事が届かずに同じ部分を送り直した時は、置いた物と同じ中身なら受け直したとみなし、何も足さない
  if (last && seq === last.seq && (await sameAs(store, nodeId, last.key, plain))) return;
  if (seq !== (last ? last.seq + 1 : 0)) throw new AppError("conflict", "会話の記録の通し番号が前回の続きでない");
  const path = transcriptPath(staffId, nodeId, sessionId, seq);
  const body = await seal(store.master, nodeId, path, plain);
  // R2 に置いた後に D1 に書けずに落ちても、同じ通し番号で送り直すと同じ道に置き直すだけで済む
  await store.files.put(path, body);
  await orm.insert(transcriptParts).values({ id: newId(clockAt(now)), staffId, nodeId, sessionId, seq, key: path, bytes: body.byteLength, createdAt: now });
}

/**
 * タスクの最後の session の会話の記録を、部分の順に復号してつなぐ
 * @param store 置き場
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @returns session、記録の全部の base64、次の通し番号。記録が無ければ null
 * @throws payload_too_large 記録の全部が上限を超える時。R2 から読まずに投げる
 * @throws internal 部分が欠けているか、戻せない時
 */
export async function loadTranscript(store: TranscriptStore, staffId: StaffId, nodeId: string): Promise<RestoreInput | null> {
  const orm = drizzle(store.db);
  const mine = and(eq(transcriptParts.staffId, staffId), eq(transcriptParts.nodeId, nodeId));
  const [latest] = await orm.select({ sessionId: transcriptParts.sessionId }).from(transcriptParts).where(mine).orderBy(desc(transcriptParts.createdAt), desc(transcriptParts.seq)).limit(1);
  if (!latest) return null;
  const parts = await orm
    .select()
    .from(transcriptParts)
    .where(and(mine, eq(transcriptParts.sessionId, latest.sessionId)))
    .orderBy(asc(transcriptParts.seq));
  // 大きすぎる記録は、ワークスペースが落ちて作り直すたびに R2 から読んで復号し直さないよう、D1 の行だけで先に断る
  const bytes = parts.reduce((sum, part) => sum + part.bytes - SEAL_OVERHEAD, 0);
  if (bytes > (store.maxBytes ?? RESTORE_TRANSCRIPT_BYTES)) {
    log("warn", "transcript_too_large", { staffId, nodeId, sessionId: latest.sessionId, parts: parts.length, bytes });
    throw new AppError("payload_too_large", "戻す会話の記録が大きすぎる");
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.seq !== index) throw new AppError("internal", "会話の記録の部分が欠けている");
    const object = await store.files.get(part.key);
    if (!object) throw new AppError("internal", "会話の記録の部分が R2 に無い");
    chunks.push(await unseal(store.master, nodeId, part.key, new Uint8Array(await object.arrayBuffer())));
  }
  const transcript = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    transcript.set(chunk, at);
    at += chunk.byteLength;
  }
  return { sessionId: latest.sessionId, transcript: toBase64(transcript), nextSeq: parts.length };
}

/**
 * 続きを呼ぶ時の、モデル、考える深さ、役目の説明文、社員の役で使える社員のツールを読む
 * @param db 今の状態の D1
 * @param staffId 社員 ID
 * @param nodeId タスク ID
 * @returns RunInput のうち、作業トークン、指示、session のほか
 * @throws internal 社員か役目の説明文が無い時
 */
async function runBase(db: D1Database, staffId: StaffId, nodeId: string): Promise<Pick<RunInput, "model" | "effort" | "systemPrompt" | "tools">> {
  const orm = drizzle(db);
  const [who] = await orm.select().from(staff).where(eq(staff.id, staffId)).limit(1);
  if (!who) throw new AppError("internal", "社員が無い");
  const [prompt] = await orm
    .select({ body: staffPrompts.body })
    .from(staffPrompts)
    .where(and(eq(staffPrompts.staffId, staffId), eq(staffPrompts.version, who.promptVersion)))
    .limit(1);
  if (!prompt) throw new AppError("internal", "役目の説明文が無い");
  const [node] = await orm.select({ taskKind: nodes.taskKind }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  const effort = EFFORT_BY_KIND[node?.taskKind ?? ""] ?? RunInput.shape.effort.parse(who.effort);
  return { model: who.model, effort, systemPrompt: prompt.body, tools: [...ROLE_TOOLS[staffId]] };
}

/**
 * ワークスペースを作り直した後に、社員が持つタスクの会話の記録を戻し、同じ session の続きを新しい作業トークンで呼ぶ
 * 止めている間と勤務の外、記録の無いタスクは呼ばない
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 作り直しを決めた時刻
 * @returns 続きを呼んだか
 * @throws unavailable ワークスペースが答えない時
 * @throws conflict ワークスペースがもう走っている時
 */
export async function resumeRun(env: Bindings, staffId: StaffId, now: number): Promise<boolean> {
  const staffDo = staffOf(env, staffId);
  const { state, nodeId } = await staffDo.status(now);
  if (nodeId === null || state === "stopped" || state === "off") return false;
  const saved = await staffDo.loadTranscript(nodeId);
  if (!saved) return false;
  const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(staffId));
  await workspace.restore(saved);
  const base = await runBase(env.DB, staffId, nodeId);
  const { token, jti } = await issueTicket(env, staffId, nodeId, now);
  try {
    await workspace.run(RunInput.parse({ ...base, nodeId, ticket: token, prompt: RESUME_PROMPT, resume: saved.sessionId }));
  } catch (error) {
    // 渡せなかった作業トークンは使われないので失効させる
    await staffDo.revokeTokens([jti]);
    throw error;
  }
  // 落ちたワークスペースに渡していた作業トークンは、続きを渡した後に使えなくする
  await retireOtherTickets(env, staffId, nodeId, jti, now);
  return true;
}
