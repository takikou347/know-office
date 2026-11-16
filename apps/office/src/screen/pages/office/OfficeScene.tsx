// オフィスの 3D の部屋。オフィスの画面を開いた時だけ読み込み、社員の姿の上に、押すと会話が開くリンクを重ね、出来事の動きを見せる
import "./office.css";
import { type ReactNode, useEffect, useRef } from "react";
import type { Staff } from "../../mock.ts";
import { STAFF_STATES } from "../../parts/staff-status.tsx";
import { type Loop, browserClock, createLoop } from "./loop.ts";
import type { EventBatch } from "./OfficePage.tsx";
import { planMotions } from "./plan.ts";
import { type ColorResolver, type Room, createRoom } from "./room.ts";
import { type TagSizer, createTagSizer, spreadTags } from "./tags.ts";
import { OFFICE_THEME, themeOf } from "./themes.ts";

export interface OfficeSceneProps {
  /** 部屋に置く社員と今の状態 */
  people: readonly Staff[];
  /** 見せる出来事のまとまり */
  batch: EventBatch | null;
  /** 動かすか。動かさない時は歩かずに置き換え、息や打鍵も止める */
  moves: boolean;
  /** 部屋を組めなかった時か、描く所を失った時に呼ぶ。2D の一覧に代える */
  onFail: () => void;
  /** 部屋の上に置く物 (動きを止めるボタンと、直近の出来事) */
  children: ReactNode;
}

/** 組んだ部屋と、描く回し方を今の様子に合わせる関数 */
interface Control {
  room: Room;
  loop: Loop;
  /** 動かすかを受け、動かす時で、画面が見えていて、部屋が画面の中にある時だけ描き続ける */
  sync: (moves: boolean) => void;
  /** リンクと名札を姿に重ねる */
  place: () => void;
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
 * 社員のリンクと名札を、姿を覆う箱に重ねる関数を作る。名札は重ならないようにずらし、変わった時だけ style を書く
 * @param room 部屋
 * @param links 社員の id ごとのリンク
 * @param sizer 名札の大きさを覚えて返す物。字が変わった時だけ測る
 * @returns 重ねる関数
 */
function placer(room: Room, links: ReadonlyMap<string, HTMLAnchorElement>, sizer: TagSizer): () => void {
  const written = new Map<string, string>();
  return () => {
    const boxes = room.boxes();
    const tags = boxes.flatMap((b) => {
      const tag = links.get(b.id)?.firstElementChild;
      if (!(tag instanceof HTMLElement)) return [];
      const { width, height } = sizer.sizeOf(b.id, tag.textContent);
      return [{ id: b.id, x: b.left + b.width / 2, bottom: b.top, width, height }];
    });
    const shift = spreadTags(tags);
    for (const b of boxes) {
      const a = links.get(b.id);
      if (!a) continue;
      const style = `translate(${Math.round(b.left)}px, ${Math.round(b.top)}px)|${Math.round(b.width)}|${Math.round(b.height)}|${Math.round(shift[b.id] ?? 0)}`;
      if (written.get(b.id) === style) continue;
      written.set(b.id, style);
      a.style.transform = `translate(${Math.round(b.left)}px, ${Math.round(b.top)}px)`;
      a.style.width = `${Math.round(b.width)}px`;
      a.style.height = `${Math.round(b.height)}px`;
      a.style.setProperty("--ko-tag-shift", `${Math.round(shift[b.id] ?? 0)}px`);
    }
  };
}

/**
 * オフィスの 3D の部屋
 * @param props 部屋に置く社員、出来事、動かすか、組めなかった時の呼び先、部屋の上に置く物
 * @returns 部屋と、社員のリンク
 */
export default function OfficeScene({ people, batch, moves, onFail, children }: OfficeSceneProps) {
  const frame = useRef<HTMLDivElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const control = useRef<Control | null>(null);
  const played = useRef(0);
  // 部屋は開いた時に 1 回だけ組む。後の変わりは出来事の動きで見せるので、組む時は初めに受けた出来事の前の状態から始める
  const first = useRef(batch?.before.staff ?? people);
  // 組む時の動かすかの初めの値。後の変わりは下の effect で部屋に伝え、組み直さない
  const initialMoves = useRef(moves);

  useEffect(() => {
    const box = frame.current;
    if (!box) return undefined;
    // canvas は組むたびに作る。捨てる時に描く所を手放すと、同じ canvas では描けなくなる
    const el = document.createElement("canvas");
    el.setAttribute("aria-hidden", "true");
    box.prepend(el);
    let room: Room;
    try {
      const seats = first.current.map((s) => ({ id: s.id, state: s.state }));
      room = createRoom(el, seats, themeOf(OFFICE_THEME), colorResolver(box), { moves: initialMoves.current, onLost: onFail });
    } catch {
      el.remove();
      onFail();
      return undefined;
    }
    // 名札は字が変わった時だけ測る。字の形を変える字体の読み込みと画面の大きさの変わりでは測り直す
    const sizer = createTagSizer((id) => {
      const tag = links.current.get(id)?.firstElementChild;
      return tag instanceof HTMLElement ? { width: tag.offsetWidth, height: tag.offsetHeight } : { width: 0, height: 0 };
    });
    const place = placer(room, links.current, sizer);
    const loop = createLoop((t) => {
      room.render(t);
      place();
    }, browserClock());
    let inView = true;
    let moving = initialMoves.current;
    const sync = (next = moving) => {
      moving = next;
      const shown = document.visibilityState === "visible";
      if (moving && shown && inView) loop.start();
      else loop.pause();
    };
    control.current = { room, loop, sync, place };
    const fit = () => {
      sizer.reset();
      room.resize(el.clientWidth, el.clientHeight);
      place();
    };
    const refont = () => {
      sizer.reset();
      place();
    };
    const resized = new ResizeObserver(fit);
    resized.observe(el);
    const seen = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      sync();
    });
    seen.observe(el);
    const visible = () => sync();
    document.addEventListener("visibilitychange", visible);
    document.fonts.addEventListener("loadingdone", refont);
    fit();
    sync();
    return () => {
      document.fonts.removeEventListener("loadingdone", refont);
      document.removeEventListener("visibilitychange", visible);
      seen.disconnect();
      resized.disconnect();
      loop.stop();
      room.dispose();
      el.remove();
      control.current = null;
    };
  }, [onFail]);

  useEffect(() => {
    const c = control.current;
    if (!c) return;
    c.room.setMoving(moves);
    c.sync(moves);
    c.place();
  }, [moves]);

  // 出来事のまとまりが来たら、前の状態のまま動きを決めて積み、それから今の状態にする
  useEffect(() => {
    const c = control.current;
    if (!c || !batch || batch.id === played.current) return;
    played.current = batch.id;
    for (const e of batch.events) c.room.play(planMotions(e, c.room.actors(), { walks: moves }));
    c.room.setStates(people.map((s) => ({ id: s.id, state: s.state })));
    c.place();
  }, [batch, people, moves]);

  useEffect(() => {
    const c = control.current;
    if (!c) return;
    c.room.setStates(people.map((s) => ({ id: s.id, state: s.state })));
    c.place();
  }, [people]);

  return (
    <section className="ko-office-room" aria-label="オフィスの部屋" data-motion={moves ? "moving" : "still"}>
      <div className="ko-office-frame" ref={frame}>
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
      {children}
      <p>社員を押すと、その社員の会話が開きます</p>
    </section>
  );
}
