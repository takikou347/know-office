// オフィスの 3D の部屋。オフィスの画面を開いた時だけ読み込み、社員の姿の上に、押すと会話が開くリンクを重ね、出来事の動きを見せる
import "./office.css";
import { type ReactNode, useEffect, useRef } from "react";
import type { Staff } from "../../mock.ts";
import { STAFF_STATES } from "../../parts/staff-status.tsx";
import type { EventBatch } from "./OfficePage.tsx";
import { planMotions } from "./plan.ts";
import { type ColorResolver, type Room, createRoom } from "./room.ts";
import { OFFICE_THEME, themeOf } from "./themes.ts";

export interface OfficeSceneProps {
  /** 部屋に置く社員と今の状態 */
  people: readonly Staff[];
  /** 見せる出来事のまとまり */
  batch: EventBatch | null;
  /** 動きを減らす設定か。歩かずに置き換える */
  reduce: boolean;
  /** 部屋を組めなかった時に呼ぶ。2D の一覧に代える */
  onFail: () => void;
  /** 直近の出来事を読み上げる所 */
  news: ReactNode;
}

/**
 * 色の書き方を three.js が読める rgb() に直す関数を作る。knowidea-tokens の色は OKLCH なので、2D の canvas に塗って読み戻す
 * @param host 変数を引く要素
 * @returns 直す関数
 */
function colorResolver(host: HTMLElement): ColorResolver {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const style = getComputedStyle(host);
  return (value) => {
    const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    const css = name ? style.getPropertyValue(name).trim() : value;
    if (!ctx) return css;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r ?? 0}, ${g ?? 0}, ${b ?? 0})`;
  };
}

/**
 * オフィスの 3D の部屋
 * @param props 部屋に置く社員、出来事、動きを減らす設定、組めなかった時の呼び先、直近の出来事
 * @returns 部屋と、社員のリンク
 */
export default function OfficeScene({ people, batch, reduce, onFail, news }: OfficeSceneProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const room = useRef<Room | null>(null);
  const played = useRef(0);
  // 部屋を組む時に使う最初の状態。組み直しのたびに読み直さないよう ref に持つ
  const first = useRef(batch?.before.staff ?? people);

  useEffect(() => {
    const box = frame.current;
    const el = canvas.current;
    if (!box || !el) return undefined;
    let built: Room;
    try {
      built = createRoom(el, first.current.map((s) => ({ id: s.id, state: s.state })), themeOf(OFFICE_THEME), colorResolver(box), { reduce });
    } catch {
      onFail();
      return undefined;
    }
    room.current = built;
    const place = () => {
      for (const b of built.boxes()) {
        const a = links.current.get(b.id);
        if (!a) continue;
        a.style.transform = `translate(${b.left}px, ${b.top}px)`;
        a.style.width = `${b.width}px`;
        a.style.height = `${b.height}px`;
      }
    };
    const fit = () => {
      built.resize(el.clientWidth, el.clientHeight);
      place();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    fit();
    let id = 0;
    if (!reduce) {
      id = requestAnimationFrame(function tick(t) {
        built.render(t);
        place();
        id = requestAnimationFrame(tick);
      });
    }
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
      built.dispose();
      room.current = null;
    };
  }, [reduce, onFail]);

  // 出来事のまとまりが来たら、前の状態のまま動きを決めて積み、それから今の状態にする
  useEffect(() => {
    const r = room.current;
    if (!r || !batch || batch.id === played.current) return;
    played.current = batch.id;
    for (const e of batch.events) r.play(planMotions(e, r.actors(), { reduce }));
    r.setStates(people.map((s) => ({ id: s.id, state: s.state })));
    first.current = people;
  }, [batch, people, reduce]);

  useEffect(() => {
    room.current?.setStates(people.map((s) => ({ id: s.id, state: s.state })));
  }, [people]);

  return (
    <section className="ko-office-room" aria-label="オフィスの部屋">
      <div className="ko-office-frame" ref={frame}>
        <canvas ref={canvas} aria-hidden="true" />
        {people.map((s) => (
          <a
            key={s.id}
            className="ko-office-who"
            href={`/staff/${s.id}`}
            data-state={s.state}
            ref={(a) => {
              if (a) links.current.set(s.id, a);
              else links.current.delete(s.id);
            }}
          >
            <span className="ko-office-tag">
              <strong>{s.role}</strong>{" "}
              <span>{STAFF_STATES[s.state].label}</span>
            </span>
          </a>
        ))}
      </div>
      {news}
      <p>社員を押すと、その社員の会話が開きます</p>
    </section>
  );
}
