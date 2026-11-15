// オフィスの 3D の部屋。オフィスの画面を開いた時だけ読み込み、社員の姿の上に、押すと会話が開くリンクを重ね、出来事の動きを見せる
import "./office.css";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Staff } from "../../mock.ts";
import { STAFF_STATES } from "../../parts/staff-status.tsx";
import { type Loop, browserClock, createLoop } from "./loop.ts";
import { type PuppyModel, loadPuppyModelOrNull } from "./model.ts";
import type { EventBatch } from "./OfficePage.tsx";
import { planMotions } from "./plan.ts";
import { type ColorResolver, type Room, createRoom } from "./room.ts";
import { spreadTags } from "./tags.ts";
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
  /** 動かす時で、画面が見えていて、部屋が画面の中にある時だけ描き続ける */
  sync: () => void;
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
 * @returns 重ねる関数
 */
function placer(room: Room, links: ReadonlyMap<string, HTMLAnchorElement>): () => void {
  const written = new Map<string, string>();
  return () => {
    const boxes = room.boxes();
    const tags = boxes.flatMap((b) => {
      const tag = links.get(b.id)?.firstElementChild;
      if (!(tag instanceof HTMLElement)) return [];
      return [{ id: b.id, x: b.left + b.width / 2, bottom: b.top, width: tag.offsetWidth, height: tag.offsetHeight }];
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
 * 最後に受けた出来事のまとまりをまだ見せていなければ動きを積み、社員の状態を今にする
 * @param c 組んだ部屋
 * @param latest 最後に受けた出来事のまとまりと社員
 * @param latest.batch 出来事のまとまり
 * @param latest.people 社員と今の状態
 * @param played 見せたまとまりの番号
 * @param played.current 番号
 * @param walks 歩かせるか
 */
function catchUp(c: Control, latest: { batch: EventBatch | null; people: readonly Staff[] }, played: { current: number }, walks: boolean): void {
  const { batch, people } = latest;
  if (batch && batch.id !== played.current) {
    played.current = batch.id;
    for (const e of batch.events) c.room.play(planMotions(e, c.room.actors(), { walks }));
  }
  c.room.setStates(people.map((s) => ({ id: s.id, state: s.state })));
  c.place();
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
  const moving = useRef(moves);
  // 部屋を組む前に来た出来事を、組んだ後に見せるため、最後に受けた物を持つ
  const latest = useRef({ batch, people });
  // 子犬の姿の元。モデルを読む間は loading、読めたら model、読めなければ形を組んだ子犬の shapes
  const [puppy, setPuppy] = useState<"loading" | "model" | "shapes">("loading");

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    // 部屋を組み、描く回し方と、大きさや見えるかの見張りを付ける。返す関数で後始末をする
    const build = (model: PuppyModel | null): (() => void) | undefined => {
      const box = frame.current;
      if (!box) {
        model?.dispose();
        return undefined;
      }
      // canvas は組むたびに作る。捨てる時に描く所を手放すと、同じ canvas では描けなくなる
      const el = document.createElement("canvas");
      el.setAttribute("aria-hidden", "true");
      box.prepend(el);
      let room: Room;
      try {
        const seats = first.current.map((s) => ({ id: s.id, state: s.state }));
        room = createRoom(el, seats, themeOf(OFFICE_THEME), colorResolver(box), { moves: moving.current, onLost: onFail, model });
      } catch {
        model?.dispose();
        el.remove();
        onFail();
        return undefined;
      }
      const place = placer(room, links.current);
      const loop = createLoop((t) => {
        room.render(t);
        place();
      }, browserClock());
      let inView = true;
      const sync = () => {
        const shown = document.visibilityState === "visible";
        if (moving.current && shown && inView) loop.start();
        else loop.pause();
      };
      control.current = { room, loop, sync, place };
      // モデルを読む間に来た出来事と状態を、組んだ部屋に当てる
      catchUp(control.current, latest.current, played, moving.current);
      const fit = () => {
        room.resize(el.clientWidth, el.clientHeight);
        place();
      };
      const resized = new ResizeObserver(fit);
      resized.observe(el);
      const seen = new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
        sync();
      });
      seen.observe(el);
      document.addEventListener("visibilitychange", sync);
      fit();
      sync();
      return () => {
        document.removeEventListener("visibilitychange", sync);
        seen.disconnect();
        resized.disconnect();
        loop.stop();
        room.dispose();
        el.remove();
        control.current = null;
      };
    };
    // 子犬のモデルを読んでから部屋を組む。読めない時と遅い時は、待たずに形を組んだ子犬で組む
    void loadPuppyModelOrNull().then((model) => {
      if (cancelled) {
        model?.dispose();
        return;
      }
      setPuppy(model ? "model" : "shapes");
      cleanup = build(model);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [onFail]);

  useEffect(() => {
    moving.current = moves;
    const c = control.current;
    if (!c) return;
    c.room.setMoving(moves);
    c.sync();
    c.place();
  }, [moves]);

  // 出来事のまとまりが来たら、前の状態のまま動きを決めて積み、それから今の状態にする
  useEffect(() => {
    latest.current = { batch, people };
    const c = control.current;
    if (c) catchUp(c, latest.current, played, moving.current);
  }, [batch, people]);

  return (
    <section className="ko-office-room" aria-label="オフィスの部屋" data-motion={moves ? "moving" : "still"} data-puppy={puppy}>
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
