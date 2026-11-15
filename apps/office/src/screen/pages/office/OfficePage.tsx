// オフィスの画面。3D を出せる時は部屋を読み込み、出せない時と動きを減らす設定の時は 2D の一覧で社員を出す
import { List } from "knowidea-ui";
import { Component, type ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { type Staff, staff } from "../../mock.ts";
import { StaffStatus } from "../../parts/staff-status.tsx";
import { REDUCED_MOTION_QUERY, browserEnv, canShow3d } from "./support.ts";

// three.js と部屋の作りは、この画面を開いた時だけ読む
const OfficeScene = lazy(() => import("./OfficeScene.tsx"));

/**
 * 社員を 2D の一覧で出す。押すと社員とタスクの画面でその社員の会話が開く
 * @param props.people 出す社員
 * @returns 社員の一覧
 */
export function OfficeList({ people }: { /** 出す社員 */ people: readonly Staff[] }) {
  return (
    <List
      label="社員の様子"
      items={people.map((s) => ({ id: s.id, title: s.role, href: `/staff/${s.id}`, meta: <><StaffStatus s={s} /> {s.now}</> }))}
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
 * オフィスの画面の中身
 * @returns 3D の部屋か 2D の一覧
 */
export function OfficePage() {
  const [mode, setMode] = useState<"checking" | "3d" | "2d">("checking");
  useEffect(() => {
    const decide = () => setMode(canShow3d(browserEnv()) ? "3d" : "2d");
    decide();
    // 開いている間に動きを減らす設定を変えても合わせる
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    query.addEventListener("change", decide);
    return () => query.removeEventListener("change", decide);
  }, []);
  const fail = useCallback(() => setMode("2d"), []);
  const list = (
    <>
      <p>動きを減らす設定か、3D を出せないブラウザなので、社員を一覧で出しています。押すとその社員の会話が開きます</p>
      <OfficeList people={staff} />
    </>
  );
  if (mode === "checking") return <p role="status">部屋を用意しています</p>;
  if (mode === "2d") return list;
  return (
    <SceneBoundary fallback={list}>
      <Suspense fallback={<p role="status">部屋を読んでいます</p>}>
        <OfficeScene staff={staff} onFail={fail} />
      </Suspense>
    </SceneBoundary>
  );
}
