// オフィスの出来事の置き場。画面を開いた時から配信を聞き、オフィスを前に開いた時からの出来事をためる。初めて読み込んだ時と読み直した時の状態は出来事にしない (画面の全体の 3.2)
import type { LiveEvent, StaffState } from "@know-office/core";
import { useLiveEvent } from "../../parts/live.tsx";
import { type OfficeEvent, type OfficeSnapshot, officeEventOf } from "./events.ts";
import { roomStateOf } from "./layout.ts";

/** ためる出来事の上限。オフィスを長く開かない間は古い物から捨てる */
export const NEWS_KEEP = 200;

/** オフィスが受け取る出来事のまとまり */
export interface TakenNews {
  /** 1 つ目の出来事の前の社員の状態。部屋はここから動きを始める */
  before: OfficeSnapshot;
  /** ためた出来事 */
  events: OfficeEvent[];
}

/** オフィスの出来事の置き場 */
export interface OfficeNews {
  /** 配信で届いた印を聞く。仕事の出来事と、知っている社員の部屋の様子の変わりをためる */
  hear: (event: LiveEvent) => void;
  /** 入口から読んだ社員の状態を、出来事にせずに知っている事にする */
  know: (staff: readonly { id: string; state: StaffState }[]) => void;
  /** ためた出来事を受け取り、空にする */
  take: () => TakenNews;
  /** 出来事がたまったら知らせる。返した関数で聞くのをやめる */
  subscribe: (listener: () => void) => () => void;
}

/**
 * オフィスの出来事の置き場を作る
 * @param keep ためる出来事の上限
 * @returns 置き場
 */
export function createOfficeNews(keep = NEWS_KEEP): OfficeNews {
  const known = new Map<string, StaffState>();
  let events: OfficeEvent[] = [];
  let before: OfficeSnapshot | null = null;
  const listeners = new Set<() => void>();
  const snapshot = (): OfficeSnapshot => ({ staff: [...known].map(([id, state]) => ({ id, state })) });
  const push = (e: OfficeEvent) => {
    // 部屋は 1 つ目の出来事の前の様子から動きを始めるので、ため始めた時の様子を覚える
    before ??= snapshot();
    events = [...events, e].slice(-keep);
    for (const l of listeners) l();
  };
  return {
    hear: (event) => {
      if (event.type === "work") {
        push(officeEventOf(event.work));
        return;
      }
      if (event.type !== "staff") return;
      const { id, state } = event.staff;
      const was = known.get(id);
      // 知らない社員の状態は前が分からないので、覚えるだけにする
      const moved = was !== undefined && roomStateOf(was) !== roomStateOf(state);
      if (moved) push({ kind: "state", staffId: id, from: roomStateOf(was), to: roomStateOf(state) });
      known.set(id, state);
    },
    know: (staff) => {
      for (const s of staff) known.set(s.id, s.state);
    },
    take: () => {
      const taken = { before: before ?? snapshot(), events };
      events = [];
      before = null;
      return taken;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 画面に 1 つだけ置く、オフィスの出来事の置き場 */
export const officeNews = createOfficeNews();

/**
 * 画面を開いている間、配信の印をオフィスの出来事の置き場に渡す。LiveProvider の中に 1 つだけ置く
 * @returns 何も描かない
 */
export function OfficeNewsFeed(): null {
  useLiveEvent((event) => officeNews.hear(event));
  return null;
}
