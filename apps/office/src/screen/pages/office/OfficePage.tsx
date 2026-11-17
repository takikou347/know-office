// オフィスの画面。社員を入口から読み、配信で届いた出来事を、3D を出せる時は部屋の動きで見せ、出せない時は 2D の一覧で社員を出す
import { StaffOverview } from "@know-office/core";
import { Button, List } from "knowidea-ui";
import { Component, type ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useLiveTick } from "../../parts/live.tsx";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { StaffStatus } from "../../parts/staff-status.tsx";
import { type OfficeEvent, type OfficeSnapshot, newsOf } from "./events.ts";
import { officeNews } from "./news.ts";
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

/**
 * 社員の ID から役目の名前を返す関数を作る。部屋に居ないオーナーは「オーナー」と読む
 * @param people 読んだ社員
 * @returns 役目の名前を返す関数
 */
const rolesOf = (people: readonly StaffOverview[]) => (id: string) => (id === "owner" ? "オーナー" : (people.find((s) => s.id === id)?.role ?? id));

/**
 * 社員を 2D の一覧で出す。押すと社員とタスクの画面でその社員の会話が開く
 * @param props.people 出す社員
 * @returns 社員の一覧
 */
export function OfficeList({ people }: { /** 出す社員 */ people: readonly StaffOverview[] }) {
  return (
    <List
      label="社員の様子"
      items={people.map((s) => ({ id: s.id, title: s.role, href: `/staff/${s.id}`, meta: <><StaffStatus state={s.state} /> {s.nodeTitle ?? ""}</> }))}
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
 * オフィスを開いている間、配信で届いてためた出来事を受け取る。開いた時は、前にオフィスを開いた時からの出来事を受け取る
 * @returns 出来事のまとまり
 */
function useOfficeEvents(): EventBatch | null {
  const [batch, setBatch] = useState<EventBatch | null>(null);
  useEffect(() => {
    let id = 0;
    const take = () => {
      const { before, events } = officeNews.take();
      if (events.length > 0) setBatch({ id: ++id, before, events });
    };
    take();
    return officeNews.subscribe(take);
  }, []);
  return batch;
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
  const batch = useOfficeEvents();
  const tick = useLiveTick((e) => e.type === "staff");
  const loaded = useLoad(z.array(StaffOverview), (a) => a.api.v1.staff.$get({ query: {} }), tick);
  // 読み直しに失敗しても、前に読めた社員で部屋を出し続け、失敗は部屋の上に出す
  const [people, setPeople] = useState<readonly StaffOverview[] | null>(null);
  // 前に読めた社員を、描く間に読めた物へ替える (React の「前の描画の値を覚える」形)
  if (loaded.state === "ok" && loaded.data !== people) setPeople(loaded.data);
  useEffect(() => {
    if (loaded.state !== "ok") return;
    // 読んだ状態は出来事にせず、次に届く状態の印の前の状態にする
    officeNews.know(loaded.data);
  }, [loaded]);
  useEffect(() => {
    // 開いている間に動きを減らす設定を変えても合わせる
    const query = window.matchMedia(MOTION_ALLOWED_QUERY);
    const follow = (e: MediaQueryListEvent) => setMotionAllowed(e.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const fail = useCallback(() => setMode("2d"), []);
  const failed = loaded.state === "failed" ? <FailedAlert title="社員を読めませんでした" failure={loaded} /> : null;
  if (people === null) return failed ?? <p role="status">社員を読んでいます</p>;
  const news = <p role="status">{newsOf(batch?.events ?? [], rolesOf(people))}</p>;
  const list = (
    <>
      <p>3D を出せないブラウザなので、社員を一覧で出しています。押すとその社員の会話が開きます</p>
      {failed}
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
          {failed}
          {halt}
          {news}
        </OfficeScene>
      </Suspense>
    </SceneBoundary>
  );
}
