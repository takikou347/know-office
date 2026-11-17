// 入口の配信 (/api/v1/live) を 1 本開き、届いた出来事を画面の部品に渡す。切れたら新しい作業トークンで、待ちを倍にしながらつなぎ直す (社員と自動の 3.7)
import { LiveEvent } from "@know-office/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../api.ts";

/** つなぎ直すまでの最初の待ち */
export const RETRY_FIRST_MS = 1000;
/** つなぎ直すまでの待ちの上限 */
export const RETRY_MAX_MS = 30_000;

/** 届いた出来事を聞く関数 */
export type LiveListener = (event: LiveEvent) => void;

/** 配信の今と、出来事を聞く口 */
export type LiveState = {
  /** 配信がつながっているか。切れている間は、部品が自分で読み直す */
  connected: boolean;
  /** 出来事を聞く。返した関数で聞くのをやめる */
  subscribe: (listener: LiveListener) => () => void;
};

/** WebSocket の口。画面ではブラウザーの WebSocket、テストは代わりの物 */
export type SocketLike = {
  /** つながった、文が届いた、切れた時に呼ぶ関数を足す */
  addEventListener(type: "open" | "close" | "message", listener: (e: { data?: unknown }) => void): void;
  /** 閉じる */
  close(): void;
};

/** 配信の口の作り方。テストは代わりの物を渡す */
export type LiveDeps = {
  /** 作業トークンを出させる。出せなければ null */
  ticket: () => Promise<string | null>;
  /** 作業トークンで WebSocket を開く */
  open: (ticket: string) => SocketLike;
  /** 待つ */
  wait: (ms: number) => Promise<void>;
};

const TicketReply = z.object({ data: z.object({ ticket: z.string() }).loose() }).loose();

/**
 * 1 本の配信を、閉じるまでつなぎ直し続ける。形の違う出来事は捨てて受け続ける
 * @param deps 配信の口の作り方
 * @param onEvent 出来事を受けた時
 * @param onConnected つながった、切れた時
 * @returns 閉じる関数
 */
export function runLive(deps: LiveDeps, onEvent: LiveListener, onConnected: (connected: boolean) => void): () => void {
  const state: { stopped: boolean; socket: SocketLike | null; delay: number } = { stopped: false, socket: null, delay: RETRY_FIRST_MS };
  const receive = (data: unknown): void => {
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = LiveEvent.safeParse(raw);
    if (parsed.success) onEvent(parsed.data);
  };
  const connect = async (): Promise<void> => {
    // 開発の StrictMode は付けてすぐ外す。同じ流れのうちに閉じられた時に作業トークンを無駄に出さないよう、1 拍待ってから始める
    await Promise.resolve();
    while (!state.stopped) {
      // 作業トークンは 1 回だけ使えるので、つなぎ直すたびに出させる
      const ticket = await deps.ticket().catch(() => null);
      if (state.stopped) return;
      if (ticket !== null) {
        await new Promise<void>((resolve) => {
          const s = deps.open(ticket);
          state.socket = s;
          s.addEventListener("open", () => {
            state.delay = RETRY_FIRST_MS;
            onConnected(true);
          });
          s.addEventListener("message", (e) => receive(e.data));
          s.addEventListener("close", () => {
            onConnected(false);
            resolve();
          });
        });
      }
      if (state.stopped) return;
      await deps.wait(state.delay);
      state.delay = Math.min(state.delay * 2, RETRY_MAX_MS);
    }
  };
  void connect();
  return () => {
    state.stopped = true;
    state.socket?.close();
  };
}

/**
 * ブラウザーで入口の配信を開く口を作る
 * @param api 入口を呼ぶ口
 * @returns 配信の口の作り方
 */
export function browserLive(api: Api): LiveDeps {
  return {
    ticket: async () => {
      const res = await api.api.v1.live.tickets.$post();
      if (!res.ok) return null;
      return TicketReply.parse(await res.json()).data.ticket;
    },
    open: (ticket) => {
      const url = api.api.v1.live.$url({ query: { ticket } });
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** 重ねないために覚えておく印の数。開いたままの画面で際限なく増えないよう、直近の物だけを覚える */
export const MARK_MEMORY = 200;

/**
 * 直近の MARK_MEMORY 個の印を覚える入れ物を作る
 * @returns 覚えているかを見る has と、覚える add
 */
function recentIds(): { has: (id: string) => boolean; add: (id: string) => void } {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.add(id);
      // Set は足した順に並ぶので、先頭が一番古い
      if (ids.size <= MARK_MEMORY) return;
      const [oldest] = ids;
      if (oldest !== undefined) ids.delete(oldest);
    },
  };
}

/**
 * 印を受けて読み直す関数を作る。同じ印は 1 回だけ読み、読み直している間に来た印はまとめて終わった後に 1 回だけ読む
 * @param pull 読み直す
 * @returns 印の ID を渡す関数
 */
export function markReloader(pull: () => Promise<void>): (id: string) => void {
  const seen = recentIds();
  let running = false;
  let again = false;
  const run = (): void => {
    running = true;
    void pull()
      .catch(() => undefined)
      .then(() => {
        running = false;
        if (!again) return;
        again = false;
        run();
      });
  };
  return (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (running) again = true;
    else run();
  };
}

const LiveContext = createContext<LiveState>({ connected: false, subscribe: () => () => {} });

export interface LiveProviderProps {
  /** 配信を使う画面 */
  children: ReactNode;
  /** 配信の口の作り方。無ければ入口を呼ぶ口から作る */
  deps?: LiveDeps;
}

/**
 * 入口の配信を 1 本開き、中の部品に渡す。入口を呼ぶ口が無い時 (サーバーで描く時とテスト) は開かない
 * @param props 中の部品
 * @returns 配信を渡す枠
 */
export function LiveProvider({ children, deps }: LiveProviderProps) {
  const api = useContext(ApiContext);
  const [connected, setConnected] = useState(false);
  const [listeners] = useState(() => new Set<LiveListener>());
  useEffect(() => {
    const made = deps ?? (api ? browserLive(api) : null);
    if (!made) return () => {};
    return runLive(
      made,
      (event) => {
        for (const l of listeners) l(event);
      },
      setConnected,
    );
  }, [api, deps, listeners]);
  const [subscribe] = useState(() => (listener: LiveListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  return <LiveContext value={{ connected, subscribe }}>{children}</LiveContext>;
}

/**
 * 配信の今と、出来事を聞く口を返す
 * @returns 配信の今
 */
export function useLive(): LiveState {
  return useContext(LiveContext);
}

/**
 * 出来事を聞く。部品が消えたら聞くのをやめる
 * @param listener 出来事を受けた時。描くたびに変わってよい
 */
export function useLiveEvent(listener: LiveListener): void {
  const { subscribe } = useLive();
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

/**
 * 1 件に 1 つの ID を持つ出来事の、同じ印を見分ける鍵を返す
 * @param event 通知、発言、発言を渡した印
 * @returns 種類と ID の鍵
 */
function idKey(event: Extract<LiveEvent, { type: "notice" | "message" | "message_delivered" }>): string {
  if (event.type === "notice") return `notice:${event.notice.id}`;
  if (event.type === "message") return `message:${event.message.id}`;
  return `delivered:${event.delivery.id}`;
}

/**
 * 出来事を数えるかを決める関数を作る。通知、発言、発言を渡した印は 1 件に 1 つの ID なので、同じ印を 2 回受けても 1 回だけ数える。
 * 社員は社員 DO が変わった時だけ出し、前と同じ状態に戻る事もあるので毎回数える。木の 1 件と仕事の出来事は何度も起きるので毎回数える
 * @returns 出来事を受けて、数えるなら true を返す関数
 */
export function liveTickCounter(): (event: LiveEvent) => boolean {
  const seen = recentIds();
  return (event) => {
    if (event.type === "staff" || event.type === "node" || event.type === "work") return true;
    const key = idKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

/**
 * 合う出来事を受けるたびと、配信がつながり直した時に増える数を返す。useLoad の読み直しの数に渡す
 * @param match 読み直す出来事か
 * @returns 読み直す数
 */
export function useLiveTick(match: (event: LiveEvent) => boolean): number {
  const { connected } = useLive();
  const [tick, setTick] = useState(0);
  const [count] = useState(liveTickCounter);
  useLiveEvent((event) => {
    if (match(event) && count(event)) setTick((t) => t + 1);
  });
  // つながり直した時は、切れていた間の変わりを拾うため 1 回読み直す
  const [was, setWas] = useState(connected);
  if (was !== connected) {
    setWas(connected);
    if (connected) setTick((t) => t + 1);
  }
  return tick;
}