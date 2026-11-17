// 画面の通知。配信の印で読み直すのを速い道にし、印を取りこぼしても 5 分ごとに (配信が切れている間は 1 分ごとに) 読む。中身の下の帯にいちばん新しい未読を、ダッシュボードに一覧を出す (サービスと拡張の 3.5、社員と自動の 3.7)
import { type Notice, type NoticeLevel, systemClock } from "@know-office/core";
import { Alert, Link, List, type Tone } from "knowidea-ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { type Api, ApiContext } from "../api.ts";
import { jstTime } from "../format.ts";
import { revealFocus } from "./focus.ts";
import { markReloader, useLive } from "./live.tsx";

/** 配信が切れている間に通知を読み直す間。起きてから 5 分以内に画面に出すので、それより短くする */
export const NOTICE_POLL_MS = 60_000;

/** 配信がつながっている間に通知を読み直す間。印で届くのが速い道で、印を配り忘れた種類の通知もこの長さのうちに出す */
export const NOTICE_LIVE_POLL_MS = 300_000;

/**
 * 通知を読み直す間を、配信がつながっているかで決める
 * @param connected 配信がつながっているか
 * @returns 読み直す間
 */
export function noticePollMs(connected: boolean): number {
  return connected ? NOTICE_LIVE_POLL_MS : NOTICE_POLL_MS;
}

/** 1 度に読む通知の数 */
const NOTICE_LIMIT = 20;

const TONES: Record<NoticeLevel, Tone> = { info: "info", warn: "warn", stop: "error" };

/** 読んだ通知と、読めたか */
type NoticesState = {
  /** 新しい順の通知 */
  notices: Notice[];
  /** 読んでいる、読めた、読めなかった */
  state: "loading" | "ok" | "error";
  /** 通知を既読にする */
  markRead: (id: string) => void;
};

/** 読んだ通知と、読めたか */
type Loaded = Pick<NoticesState, "notices" | "state">;

/**
 * 入口から通知を新しい順に読む
 * @param api 入口を呼ぶ口
 * @returns 通知。読めなければ null
 */
export async function fetchNotices(api: Api): Promise<Notice[] | null> {
  const res = await api.api.v1.notices.$get({ query: { limit: String(NOTICE_LIMIT) } }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()).data;
}

/**
 * 読む関数を、最後に始めた読みの答えだけを渡す形に包む。先に始めた読みの答えが後から届いても、新しい答えを古い答えで上書きしない
 * @param load 読む関数
 * @param apply 答えを渡す先
 * @returns 読む関数
 */
export function latestOnly<T>(load: () => Promise<T>, apply: (value: T) => void): () => Promise<void> {
  let started = 0;
  return async () => {
    started += 1;
    const mine = started;
    const value = await load();
    if (mine === started) apply(value);
  };
}

/** タブの見え方。画面では document */
export type NoticeView = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/**
 * 今読み、その後は ms ごとに読む。タブが見えない間は読まず、見えた時に 1 回読む
 * @param pull 読む関数
 * @param view タブの見え方。無ければ見えている事にする
 * @param ms 読み直す間
 * @returns 読むのを止める関数
 */
export function watchNotices(pull: () => void, view: NoticeView | null, ms: number = NOTICE_POLL_MS): () => void {
  const tick = () => {
    if (!view?.hidden) pull();
  };
  tick();
  const timer = setInterval(tick, ms);
  view?.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(timer);
    view?.removeEventListener("visibilitychange", tick);
  };
}

const NoticesContext = createContext<NoticesState>({ notices: [], state: "loading", markRead: () => {} });

export interface NoticeProviderProps {
  /** 通知を使う画面 */
  children: ReactNode;
}

/**
 * 通知を入口から読み、中の部品に渡す。入口を呼ぶ口が無い時 (サーバーで描く時とテスト) は読まない
 * @param props 中の部品
 * @returns 通知を渡す枠
 */
export function NoticeProvider({ children }: NoticeProviderProps) {
  const api = useContext(ApiContext);
  const { connected, subscribe } = useLive();
  const [loaded, setLoaded] = useState<Loaded>({ notices: [], state: "loading" });
  useEffect(() => {
    if (!api) return () => {};
    let live = true;
    // 読み直しが重なると答えの届く順が入れ替わるので、最後に始めた読みの答えだけを使う
    const pull = latestOnly(
      () => fetchNotices(api),
      (value) => {
        if (!live) return;
        setLoaded((before) => (value ? { notices: value, state: "ok" } : { ...before, state: "error" }));
      },
    );
    const onMark = markReloader(pull);
    const unsubscribe = subscribe((event) => {
      if (event.type === "notice") onMark(event.notice.id);
    });
    // 印で読み直すのが速い道。つながった時と切れた時に 1 回読んで間の通知を拾い、印を取りこぼしても読み直す間のうちに出す
    const stop = watchNotices(() => void pull(), typeof document === "undefined" ? null : document, noticePollMs(connected));
    return () => {
      live = false;
      unsubscribe();
      stop();
    };
  }, [api, connected, subscribe]);
  const markRead = useCallback(
    (id: string) => {
      if (!api) return;
      // 押した時に帯から消し、入口の答えを待たない。既読にできなければ帯に戻す
      const mark = (readAt: string | null) => setLoaded((before) => ({ ...before, notices: before.notices.map((n) => (n.id === id ? { ...n, readAt } : n)) }));
      mark(new Date(systemClock.now()).toISOString());
      void api.api.v1.notices[":noticeId"].read
        .$put({ param: { noticeId: id } })
        .then((res) => res.ok)
        .catch(() => false)
        .then((done) => {
          if (!done) mark(null);
        });
    },
    [api],
  );
  return <NoticesContext value={{ ...loaded, markRead }}>{children}</NoticesContext>;
}

export interface NoticeBarProps {
  /** 新しい順の通知 */
  notices: Notice[];
  /** 読んだを押した時 */
  onRead: (id: string) => void;
}

/**
 * 上部の帯。いちばん新しい未読の通知と、ほかの未読の数を出す。開く先があれば「開く」で移る。未読が無ければ出さない
 * @param props 通知と、読んだを押した時
 * @returns 帯
 */
export function NoticeBar({ notices, onRead }: NoticeBarProps) {
  const unread = notices.filter((n) => n.readAt === null);
  const [top] = unread;
  if (!top) return null;
  const others = unread.length - 1;
  return (
    <Alert tone={TONES[top.level]} title={top.title} live onClose={() => onRead(top.id)} closeLabel="読んだ" {...(top.link ? { action: <Link href={top.link}>開く</Link> } : {})}>
      {top.body}
      {others > 0 ? ` ほかに未読が ${String(others)} 件` : null}
    </Alert>
  );
}

export interface NoticeListProps {
  /** 新しい順の通知 */
  notices: Notice[];
  /** 読んでいる、読めた、読めなかった */
  state: NoticesState["state"];
}

/**
 * 一覧の様子を決める
 * @param state 読んでいる、読めた、読めなかった
 * @param count 通知の数
 * @returns 一覧の様子
 */
function listState(state: NoticesState["state"], count: number): "loading" | "ready" | "empty" | "error" {
  if (state !== "ok") return state;
  return count === 0 ? "empty" : "ready";
}

/**
 * ダッシュボードの通知の一覧。読んだ通知も出し、時刻は日本時間で出す。開く先のある行はその画面へ移る
 * @param props 通知と、読めたか
 * @returns 一覧
 */
export function NoticeList({ notices, state }: NoticeListProps) {
  return (
    <List
      label="お知らせ"
      state={listState(state, notices.length)}
      items={notices.map((n) => ({ id: n.id, title: n.title, ...(n.link ? { href: n.link } : {}), meta: `${jstTime(n.at)}${n.readAt === null ? "、未読" : ""}${n.body ? `、${n.body}` : ""}` }))}
      emptyText="お知らせは無い"
      errorText="お知らせを読めませんでした"
      loadingText="お知らせを読んでいます"
    />
  );
}

/** 帯が出た直後や替わった直後に、押すのを受けない長さ。中身の下の端を押そうとした指の下に帯が来ても、誤って既読にしたり移ったりしない */
export const NOTICE_FRESH_MS = 300;

/**
 * 入口から読んだ通知で、中身の下に帯を出す。中身の上の端は動かさない
 * @returns 帯
 */
export function LiveNoticeBar() {
  const { notices, markRead } = useContext(NoticesContext);
  const ref = useRef<HTMLDivElement>(null);
  const topId = notices.find((n) => n.readAt === null)?.id ?? null;
  // 帯に出す通知が替わった時を、描く間に覚える (React の「前の描画の値を覚える」形)。freshId は押すのを受けない間の通知
  const [shownId, setShownId] = useState(topId);
  const [freshId, setFreshId] = useState<string | null>(null);
  if (shownId !== topId) {
    setShownId(topId);
    setFreshId(topId);
  }
  useEffect(() => {
    if (freshId === null) return () => {};
    const timer = setTimeout(() => setFreshId(null), NOTICE_FRESH_MS);
    return () => clearTimeout(timer);
  }, [freshId]);
  useEffect(() => {
    const band = ref.current;
    if (!band || typeof ResizeObserver === "undefined") return () => {};
    // 帯は中身の下の段にあり、通知は配信でいつでも届く。帯が出たり高くなったりすると中身の段が下から縮み、中身の下の端で focus した物が
    // 帯の後ろへ押し出されて隠れる (WCAG 2.2 の 2.4.11)。帯の高さが変わるたびに、中身にある focus した物を見える所へ戻す
    const observer = new ResizeObserver(() => revealFocus(band.ownerDocument));
    observer.observe(band);
    return () => observer.disconnect();
  }, []);
  const read = useCallback(
    (id: string) => {
      // 「読んだ」を押すと帯ごと消えるので、帯の中にあった focus を中身へ戻し、失わない
      const band = ref.current;
      if (band?.contains(band.ownerDocument.activeElement)) band.ownerDocument.querySelector("main")?.focus({ preventScroll: true });
      markRead(id);
    },
    [markRead],
  );
  return (
    <div ref={ref} className="ko-notice-band" data-fresh={freshId === null ? undefined : ""}>
      <NoticeBar notices={notices} onRead={read} />
    </div>
  );
}

/**
 * 入口から読んだ通知で一覧を出す
 * @returns 一覧
 */
export function LiveNoticeList() {
  const { notices, state } = useContext(NoticesContext);
  return <NoticeList notices={notices} state={state} />;
}
