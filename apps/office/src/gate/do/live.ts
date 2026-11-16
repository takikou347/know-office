// 配信 DO。全体で 1 つ。作業トークンを出して使わせ、画面の WebSocket を休ませる形で持ち、出来事を配る (社員と自動の 3.7)
import { DurableObject } from "cloudflare:workers";
import { log, systemClock } from "@know-office/core";
import { z } from "zod";
import type { Bindings, Live } from "../env.ts";
import { LIVE_MAX_AGE_MS, LIVE_MAX_SOCKETS } from "../live/limits.ts";
import { LiveTickets } from "../live/tickets.ts";

/** WebSocket に付けて休ませても残す、接続の印 */
const Attachment = z.object({ sessionId: z.string(), ip: z.string(), openedAt: z.number() });

/** 1008 (方針に反する) で閉じる時の理由。RFC 6455 の 7.4.1 */
const POLICY = 1008;
/** 1000 (正常) で閉じる時の理由 */
const NORMAL = 1000;

/**
 * 接続を閉じる。閉じかけで投げても、ほかの接続を閉じ続ける
 * @param ws 接続
 * @param code 閉じる理由の番号
 * @param reason 閉じる理由
 */
function shut(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch (error) {
    log("warn", "live_close_socket_failed", { error: error instanceof Error ? error.message : "unknown" });
  }
}

/** 配信 DO */
export class LiveDO extends DurableObject<Bindings> implements Live {
  #tickets = new LiveTickets(this.ctx.storage.kv);

  /**
   * 作業トークンを出す
   * @param now 今の時刻
   * @returns 作業トークンと切れる時刻
   * @throws rate_limited 使える作業トークンが 20 枚ある時
   */
  issue(now: number): Promise<{ ticket: string; expiresAt: string }> {
    return this.#tickets.issue(now);
  }

  /**
   * 作業トークンを使った事にする
   * @param ticket 作業トークン
   * @param now 今の時刻
   * @returns 使えたら true
   */
  redeem(ticket: string, now: number): Promise<boolean> {
    return this.#tickets.redeem(ticket, now);
  }

  /**
   * ゲートウェイが確かめた切り替えを受け、WebSocket を休ませる形で持つ。ログインセッションと送信元を印にする
   * @param request ゲートウェイから回した要求。x-live-session、x-live-ip、x-live-at (ゲートウェイの時刻) を持つ
   * @returns 101
   */
  override async fetch(request: Request): Promise<Response> {
    const sessionId = request.headers.get("x-live-session") ?? "";
    const ip = request.headers.get("x-live-ip") ?? "";
    const at = Number(request.headers.get("x-live-at"));
    const openedAt = Number.isSafeInteger(at) ? at : systemClock.now();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`session:${sessionId}`, `ip:${ip}`]);
    server.serializeAttachment({ sessionId, ip, openedAt });
    // 上限を超えた分は、古い物から閉じる。開いた順は休んでも残る印の時刻で決める
    const sockets = this.#sockets().toSorted((a, b) => a.openedAt - b.openedAt);
    for (const old of sockets.slice(0, Math.max(0, sockets.length - LIVE_MAX_SOCKETS))) shut(old.ws, POLICY, "too many connections");
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(openedAt + LIVE_MAX_AGE_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 出来事を開いている WebSocket に配る。休んでいた DO も ctx.getWebSockets から配り先を読む
   * @param event 形を確かめた出来事
   * @returns 無し
   */
  publish(event: unknown): Promise<null> {
    const frame = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch (error) {
        // 閉じかけの接続は送れない。ほかの接続には配り続ける
        log("warn", "live_send_failed", { error: error instanceof Error ? error.message : "unknown" });
      }
    }
    return Promise.resolve(null);
  }

  /**
   * そのログインセッションの WebSocket を閉じる
   * @param sessionId ログインセッションの ID
   * @returns 無し
   */
  closeSession(sessionId: string): Promise<null> {
    for (const ws of this.ctx.getWebSockets(`session:${sessionId}`)) shut(ws, POLICY, "session ended");
    return Promise.resolve(null);
  }

  /**
   * その送信元の WebSocket を閉じる。ロックアウトした時に呼ぶ
   * @param ip 送信元
   * @returns 無し
   */
  closeIp(ip: string): Promise<null> {
    for (const ws of this.ctx.getWebSockets(`ip:${ip}`)) shut(ws, POLICY, "locked out");
    return Promise.resolve(null);
  }

  /**
   * すべての WebSocket を閉じる。ほかの端末を切った時は今の端末の物を残す
   * @param except 残すログインセッションの ID
   * @returns 無し
   */
  closeAll(except: string | null): Promise<null> {
    for (const s of this.#sockets()) if (s.sessionId !== except) shut(s.ws, POLICY, "closed by owner");
    return Promise.resolve(null);
  }

  /**
   * 開いてから 1 時間を過ぎた接続を閉じ、残りがあれば次の alarm を掛ける
   * @returns 無し
   */
  override async alarm(): Promise<void> {
    // alarm は時刻を受けないので、ここだけ時計を読む
    const now = systemClock.now();
    const sockets = this.#sockets();
    for (const s of sockets) if (now - s.openedAt >= LIVE_MAX_AGE_MS) shut(s.ws, NORMAL, "max age");
    const left = sockets.filter((s) => now - s.openedAt < LIVE_MAX_AGE_MS);
    const next = left.reduce((min, s) => Math.min(min, s.openedAt + LIVE_MAX_AGE_MS), Number.POSITIVE_INFINITY);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  /**
   * 画面からの送信は受けない。送ってきた接続は 1008 で閉じる
   * @param ws 送ってきた接続
   */
  override webSocketMessage(ws: WebSocket): void {
    shut(ws, POLICY, "client messages are not accepted");
  }

  /**
   * 画面が閉じた接続を閉じ返す
   * @param ws 閉じた接続
   * @param code 閉じた理由の番号
   */
  override webSocketClose(ws: WebSocket, code: number): void {
    // 1005 (理由無し) と 1006 (異常) は送り返せない番号なので、正常で閉じ返す
    shut(ws, code === 1005 || code === 1006 ? NORMAL : code, "closed");
  }

  /**
   * 開いている接続と、その印を並べる
   * @returns 接続と印
   */
  #sockets(): { ws: WebSocket; sessionId: string; openedAt: number }[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const a = Attachment.safeParse(ws.deserializeAttachment());
      return a.success ? [{ ws, sessionId: a.data.sessionId, openedAt: a.data.openedAt }] : [];
    });
  }
}
