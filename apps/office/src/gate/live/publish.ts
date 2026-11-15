// 出来事を配信 DO に渡す口。形を確かめてから渡し、届かなくても呼んだ処理は止めない (社員と自動の 3.7)
import type { DurableObjectStub } from "@cloudflare/workers-types";
import { type Clock, LiveEvent } from "@know-office/core";
import type { Bindings, Live } from "../env.ts";
import { recordError } from "../ledger/errors.ts";

/** 配信 DO の名前。全体で 1 つ */
const LIVE_NAME = "live";

/**
 * 配信 DO を返す
 * @param env バインディング
 * @returns 配信 DO の RPC
 */
export function liveOf(env: Pick<Bindings, "LIVE">): DurableObjectStub<Live> {
  return env.LIVE.get(env.LIVE.idFromName(LIVE_NAME));
}

/**
 * 出来事を配る。決めた形でない物は配らず、エラーログに live_event_invalid を残す。配れなかった時はエラーログに live_publish_failed を残し、投げない
 * @param env バインディング
 * @param event 配る出来事
 * @param clock 時刻
 */
export async function announce(env: Bindings, event: unknown, clock: Clock): Promise<void> {
  const parsed = LiveEvent.safeParse(event);
  if (!parsed.success) {
    // 中身は鍵や本文を含み得るので、エラーログには形の違いの数だけを残す
    await recordError(env, { source: "live_do", level: "warn", code: "live_event_invalid", error: new Error(`形が違う所が ${String(parsed.error.issues.length)} か所`) }, clock);
    return;
  }
  try {
    await liveOf(env).publish(parsed.data);
  } catch (error) {
    await recordError(env, { source: "live_do", level: "warn", code: "live_publish_failed", error }, clock);
  }
}

/**
 * 通知を足した事を配る。画面は印を受けて通知を読み直す
 * @param env バインディング
 * @param noticeId 足した通知の ID
 * @param clock 時刻
 * @returns 配り終えた時
 */
export function announceNotice(env: Bindings, noticeId: string, clock: Clock): Promise<void> {
  return announce(env, { type: "notice", notice: { id: noticeId } }, clock);
}

/**
 * 配信 DO に接続を閉じさせる。届かなくても呼んだ処理 (ログアウト、停止) は止めず、エラーログに live_close_failed を残す
 * @param env バインディング
 * @param clock 時刻
 * @param close 閉じ方
 */
export async function closeLive(env: Bindings, clock: Clock, close: (live: Live) => Promise<null>): Promise<void> {
  try {
    await close(liveOf(env));
  } catch (error) {
    await recordError(env, { source: "live_do", level: "warn", code: "live_close_failed", error }, clock);
  }
}
