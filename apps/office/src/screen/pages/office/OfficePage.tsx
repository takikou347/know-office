// オフィスの画面。画面のデータの変わりから出来事を起こし、3D を出せる時は部屋で動きを見せ、出せない時は 2D の一覧で社員を出す
import { Button, List } from "knowidea-ui";
import { Component, type ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { type Staff, staff } from "../../mock.ts";
import { StaffStatus } from "../../parts/staff-status.tsx";
import { type OfficeEvent, type OfficeSnapshot, eventsBetween, newsOf } from "./events.ts";
import { workFeed } from "./feed.ts";
import { MOTION_ALLOWED_QUERY, browserEnv, canShow3d } from "./support.ts";

// three.js と部屋の作りは、この画面を開いた時だけ読む
const OfficeScene = lazy(() => import("./OfficeScene.tsx"));

/** 部屋に渡す出来事のまとまり。id が変わるたびに部屋が動きを積む */
export interface EventBatch {
  id: number;
  /** 出来事の前の写し */
  before: OfficeSnapshot;
  events: OfficeEvent[];
}

const roleOf = (id: string) => staff.find((s) => s.id === id)?.role ?? id;

/**
 * 写しの状態を、社員の役目と今の様子に重ねる
 * @param snap 写し
 * @returns 画面に出す社員
 */
const peopleOf = (snap: OfficeSnapshot): Staff[] =>
  staff.map((s) => ({ ...s, state: snap.staff.find((x) => x.id === s.id)?.state ?? s.state }));

/**
 * 社員を 2D の一覧で出す。押すと社員とタスクの画面でその社員の会話が開く
 * @param props.people 出す社員
 * @returns 社員の一覧
 */
export function OfficeList({ people }: { /** 出す社員 */ people: readonly Staff[] }) {
  return (
    <List
      label="社員の様子"
      items={people.map((s) => ({ id: s.id, title: s.role, href: `/staff/${s.id}`, meta: <><StaffStatus state={s.state} /> {s.now}</> }))}
    />
  );
}

/** 部屋の読み込みか描画で投げた時に、2D の一覧に代える */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * 画面のデータの変わりを聞き、前にオフィスが見た写しとの違いを出来事にする
 * @returns 今の写しと、出来事のまとまり
 */
function useOfficeEvents() {
  const [snap, setSnap] = useState(workFeed.snapshot);
  const [batch, setBatch] = useState<EventBatch | null>(null);
  useEffect(() => {
    let id = 0;
    const take = () => {
      const { before, now } = workFeed.take();
      setSnap(now);
      const events = eventsBetween(before, now);
      if (events.length > 0) setBatch({ id: ++id, before, events });
    };
    take();
    return workFeed.subscribe(take);
  }, []);
  return { snap, batch };
}

/**
 * オフィスの画面の中身
 * @returns 3D の部屋か 2D の一覧と、直近の出来事
 */
export function OfficePage() {
  // サーバーで描く時はブラウザが無いので、確かめている事だけを出す
  const browser = typeof window !== "undefined";
  const [mode, setMode] = useState<"checking" | "3d" | "2d">(() => {
    if (!browser) return "checking";
    return canShow3d(browserEnv()) ? "3d" : "2d";
  });
  const [motionAllowed, setMotionAllowed] = useState(() => browser && window.matchMedia(MOTION_ALLOWED_QUERY).matches);
  // 動きを止めるボタンで止めているか。開き直すと動く所から始める
  const [halted, setHalted] = useState(false);
  const { snap, batch } = useOfficeEvents();
  useEffect(() => {
    // 開いている間に動きを減らす設定を変えても合わせる
    const query = window.matchMedia(MOTION_ALLOWED_QUERY);
    const follow = (e: MediaQueryListEvent) => setMotionAllowed(e.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const fail = useCallback(() => setMode("2d"), []);
  const people = peopleOf(snap);
  const news = <p role="status">{newsOf(batch?.events ?? [], roleOf)}</p>;
  const list = (
    <>
      <p>3D を出せないブラウザなので、社員を一覧で出しています。押すとその社員の会話が開きます</p>
      {news}
      <OfficeList people={people} />
    </>
  );
  if (mode === "checking") return <p role="status">部屋を用意しています</p>;
  if (mode === "2d") return list;
  // 動きを減らす設定では初めから動かさないので、止めるボタンは出さない
  const halt = motionAllowed ? (
    <Button variant="secondary" aria-pressed={halted} onClick={() => setHalted((h) => !h)}>
      動きを止める
    </Button>
  ) : null;
  return (
    <SceneBoundary fallback={list}>
      <Suspense fallback={<p role="status">部屋を読んでいます</p>}>
        <OfficeScene people={people} batch={batch} moves={motionAllowed && !halted} onFail={fail}>
          {halt}
          {news}
        </OfficeScene>
      </Suspense>
    </SceneBoundary>
  );
}
