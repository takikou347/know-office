// 社員の進みを受ける所。チェックポイントを社員 DO と出来事に渡して作業トークンを差し替え、社員の発言を会話に残す。社員のツールとワークスペースの出来事の両方から呼ぶ (社員が考えるの 3.2、3.7)
import { type CheckpointInput, type StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { staffOf } from "../guard/actions.ts";
import { rethrowRpc } from "../rpc.ts";
import { appendMessage } from "../routes/messages.ts";
import { clockAt } from "./attendance.ts";
import { appendNodeEvent } from "./nodes.ts";
import { renewTicket } from "./ticket.ts";

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
 * 社員の発言を会話に 1 行足し、開いている画面に配る。2,000 字を超える本文は R2 に置き、行と配る出来事には頭だけを置く
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
  const message = await appendMessage(env, { ...said, sender: "staff", traceId: traceId ?? null }, clockAt(now));
  return message.id;
}
