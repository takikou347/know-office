// エディタの補完の接続を閉じさせる口と、配信の同時の数に入れる口。ログアウト、締め出し、全体の停止は配信と同じ時に 3 人分を閉じさせる (タスクとレビューの 3.2、社員が考えるの 3.8)
import { type Clock, StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import type { LspCloseFilter } from "../work/editor-lsp.ts";
import { recordError } from "../ledger/errors.ts";
import { liveOf } from "./publish.ts";

/**
 * 3 人のワークスペースの補完の接続のうち、合う物を閉じさせる。届かなくても呼んだ処理 (ログアウト、停止) は止めず、エラーログに lsp_close_failed を残す
 * @param env バインディング
 * @param clock 時刻
 * @param filter 閉じる相手
 */
export async function closeLspAll(env: Bindings, clock: Clock, filter: LspCloseFilter): Promise<void> {
  for (const staffId of StaffId.options) {
    try {
      await env.WORKSPACE.get(env.WORKSPACE.idFromName(staffId)).closeLsp(filter);
    } catch (error) {
      await recordError(env, { source: "workspace", level: "warn", code: "lsp_close_failed", error }, clock);
    }
  }
}

/**
 * 開いた補完の接続を配信の同時の数に入れる。届かなくても補完は止めず、エラーログに lsp_hold_failed を残す
 * @param env バインディング
 * @param clock 時刻
 * @param staffId ワークスペースの社員
 * @param openedAt 開いた時刻
 */
export async function holdLspSlot(env: Bindings, clock: Clock, staffId: StaffId, openedAt: number): Promise<void> {
  try {
    await liveOf(env).holdLsp(staffId, openedAt);
  } catch (error) {
    await recordError(env, { source: "live_do", level: "warn", code: "lsp_hold_failed", error }, clock);
  }
}

/**
 * 配信の同時の数に入れた補完の接続を外す。つなげなかった時に呼ぶ。届かなくてもエラーログに lsp_release_failed を残すだけにする
 * @param env バインディング
 * @param clock 時刻
 * @param staffId ワークスペースの社員
 * @param openedAt 開いた時刻。入れた時と同じ物
 */
export async function releaseLspSlot(env: Bindings, clock: Clock, staffId: StaffId, openedAt: number): Promise<void> {
  try {
    await liveOf(env).releaseLsp(staffId, openedAt);
  } catch (error) {
    await recordError(env, { source: "live_do", level: "warn", code: "lsp_release_failed", error }, clock);
  }
}
