// オフィスの 3D の部屋。オフィスの画面を開いた時だけ読み込み、社員の姿の上に、押すと会話が開くリンクを重ねる
import "./office.css";
import { useEffect, useRef } from "react";
import type { Staff } from "../../mock.ts";
import { STAFF_STATES } from "../../parts/staff-status.tsx";
import { type ColorResolver, createRoom } from "./room.ts";
import { OFFICE_THEME, themeOf } from "./themes.ts";

export interface OfficeSceneProps {
  /** 部屋に置く社員 */
  staff: readonly Staff[];
  /** 部屋を組めなかった時に呼ぶ。2D の一覧に代える */
  onFail: () => void;
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
 * @param props.staff 部屋に置く社員
 * @param props.onFail 部屋を組めなかった時に呼ぶ
 * @returns 部屋と、社員のリンク
 */
export default function OfficeScene({ staff, onFail }: OfficeSceneProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    const box = frame.current;
    const el = canvas.current;
    if (!box || !el) return undefined;
    let room: ReturnType<typeof createRoom>;
    try {
      room = createRoom(el, staff.map((s) => ({ id: s.id, state: s.state })), themeOf(OFFICE_THEME), colorResolver(box));
    } catch {
      onFail();
      return undefined;
    }
    const place = () => {
      for (const b of room.boxes()) {
        const a = links.current.get(b.id);
        if (!a) continue;
        a.style.left = `${b.left}px`;
        a.style.top = `${b.top}px`;
        a.style.width = `${b.width}px`;
        a.style.height = `${b.height}px`;
      }
    };
    const fit = () => {
      room.resize(el.clientWidth, el.clientHeight);
      place();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    fit();
    let id = requestAnimationFrame(function tick(t) {
      room.render(t);
      id = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
      room.dispose();
    };
  }, [staff, onFail]);

  return (
    <section className="ko-office-room" aria-label="オフィスの部屋">
      <div className="ko-office-frame" ref={frame}>
        <canvas ref={canvas} aria-hidden="true" />
        {staff.map((s) => (
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
      <p>社員を押すと、その社員の会話が開きます</p>
    </section>
  );
}
