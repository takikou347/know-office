// 画面の通知。配信の印で読み直すのを速い道にし、印を取りこぼしても 5 分ごとに (配信が切れている間は 1 分ごとに) 読む。上部の帯にいちばん新しい未読を、ダッシュボードに一覧を出す (サービスと拡張の 3.5、社員と自動の 3.7)
import { type Notice, type NoticeLevel, systemClock } from "@know-office/core";
import { Alert, Link, List, type Tone } from "knowidea-ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type Api, ApiContext } from "../api.ts";
import { jstTime } from "../format.ts";
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

/** 開いた時に、初めの通知を待って画面を描かずにおく長さの上限。帯が後から差し込まれて、押そうとした物がずれないようにする */
export const NOTICE_HOLD_MS = 1_000;

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
  /** 初めの通知を待って、画面を描かずにいるか */
  holding: boolean;
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

/** 画面を描き始める時を決める物 */
export type NoticeHoldTimer = {
  /** 初めの通知が届いた (読めなかった時も含む) */
  settled: () => void;
  /** 待つのを止める。もう release を呼ばない */
  stop: () => void;
};

/**
 * 初めの通知が届くか、ms が過ぎるかの早い方で、1 度だけ release を呼ぶ
 * @param release 画面を描き始める関数
 * @param ms 待つ長さの上限
 * @returns 届いた事を伝える関数と、止める関数
 */
export function holdNotices(release: () => void, ms: number = NOTICE_HOLD_MS): NoticeHoldTimer {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    release();
  };
  const timer = setTimeout(once, ms);
  return {
    settled: once,
    stop: () => {
      done = true;
      clearTimeout(timer);
    },
  };
}

const NoticesContext = createContext<NoticesState>({ notices: [], state: "loading", markRead: () => {}, holding: false });

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
  // 入口を呼ぶ口が無い時は読まないので、待たない
  const [holding, setHolding] = useState(api !== null);
  useEffect(() => {
    if (!api) return () => {};
    let live = true;
    const hold = holdNotices(() => setHolding(false));
    const pull = async (): Promise<void> => {
      const value = await fetchNotices(api);
      if (!live) return;
      setLoaded((before) => (value ? { notices: value, state: "ok" } : { ...before, state: "error" }));
      hold.settled();
    };
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
      hold.stop();
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
  return <NoticesContext value={{ ...loaded, markRead, holding }}>{children}</NoticesContext>;
}

export interface NoticeHoldProps {
  /** 待ってから描く画面 */
  children: ReactNode;
}

/**
 * 開いた時に、初めの通知が届くまで (長くて NOTICE_HOLD_MS) 画面を描かず、帯と中身を一緒に描く。
 * 隠して描くと、待つ間に移った画面で focus と Tab の行き先が隠れた物に当たるので、描かずに待つ
 * @param props 画面
 * @returns 画面。待つ間は何も描かない
 */
export function NoticeHold({ children }: NoticeHoldProps) {
  const { holding } = useContext(NoticesContext);
  return holding ? null : children;
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

/**
 * 入口から読んだ通知で上部の帯を出す
 * @returns 帯
 */
export function LiveNoticeBar() {
  const { notices, markRead } = useContext(NoticesContext);
  return <NoticeBar notices={notices} onRead={markRead} />;
}

/**
 * 入口から読んだ通知で一覧を出す
 * @returns 一覧
 */
export function LiveNoticeList() {
  const { notices, state } = useContext(NoticesContext);
  return <NoticeList notices={notices} state={state} />;
}
