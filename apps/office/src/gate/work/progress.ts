// 社員の進みを受ける所。チェックポイントを社員 DO と出来事に渡して作業トークンを差し替え、社員の発言を会話に残す。社員のツールとワークスペースの出来事の両方から呼ぶ (社員が考えるの 3.2、3.7)
import { type CheckpointInput, newId, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { messages } from "../db/records.ts";
import type { Bindings } from "../env.ts";
import { staffOf } from "../guard/actions.ts";
import { rethrowRpc } from "../rpc.ts";
import { clockAt } from "./attendance.ts";
import { appendNodeEvent, recordsOf } from "./nodes.ts";
import { renewTicket } from "./ticket.ts";

/** 会話の行に置く本文の長さ。超える分は R2 に置く (ルートの一覧の 1.6) */
export const MESSAGE_INLINE_CHARS = 2000;

/**
 * チェックポイントを社員 DO に渡し、node_events に残し、残りが 10 分を切った作業トークンを差し替える
 * @param env バインディング
 * @param staffId 社員 ID
 * @param input CheckpointInput
 * @param now 今の時刻
 * @param traceId 要求のトレース ID
 * @returns 作業トークンを差し替えたか
 * @throws conflict 今のタスクと違う時
 */
export async function reachCheckpoint(env: Bindings, staffId: StaffId, input: CheckpointInput, now: number, traceId?: string): Promise<boolean> {
  // DO の RPC を越えると AppError のクラスが消えるので、断った code を戻す
  await staffOf(env, staffId).checkpoint(input, now).catch(rethrowRpc);
  await appendNodeEvent(env, { nodeId: input.nodeId, staffId, kind: "checkpoint", detail: { kind: input.kind, ...(input.note === undefined ? {} : { note: input.note }) } }, { by: staffId, now, traceId });
  return renewTicket(env, staffId, input.nodeId, now);
}

/**
 * 社員の発言を会話に 1 行足す。2,000 字を超える本文は R2 に置き、行には頭だけを置く
 * @param env バインディング
 * @param said 社員、タスク、本文
 * @param said.staffId 社員 ID
 * @param said.nodeId タスク ID
 * @param said.body 本文
 * @param now 今の時刻
 * @param traceId 要求のトレース ID
 * @returns 足した行の ID
 */
export async function addStaffMessage(env: Bindings, said: { staffId: StaffId; nodeId: string; body: string }, now: number, traceId?: string): Promise<string> {
  const id = newId(clockAt(now));
  let bodyKey: string | null = null;
  if (said.body.length > MESSAGE_INLINE_CHARS) {
    // R2 の置き場は確かめた社員 ID と作った ID だけから組み立てる
    bodyKey = `messages/${said.staffId}/${id}.txt`;
    await env.FILES.put(bodyKey, said.body);
  }
  await drizzle(recordsOf(env, now))
    .insert(messages)
    .values({ id, at: now, staffId: said.staffId, nodeId: said.nodeId, sender: "staff", body: said.body.slice(0, MESSAGE_INLINE_CHARS), bodyKey, traceId: traceId ?? null });
  // TODO(#76): 開いている画面へ LiveDO で配る
  return id;
}
