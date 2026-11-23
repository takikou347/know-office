// オフィスの 3D の部屋。オフィスの画面を開いた時だけ読み込み、社員の姿の上に、押すと会話が開くリンクを重ね、出来事の動きを見せる
import "./office.css";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { Button, Stack } from "knowidea-ui";
import type { StaffOverview } from "@know-office/core";
import { STAFF_STATES } from "../../parts/staff-status.tsx";
import { roomStateOf } from "./layout.ts";
import { type Loop, browserClock, createLoop } from "./loop.ts";
import type { EventBatch } from "./OfficePage.tsx";
import { planMotions } from "./plan.ts";
import { type ColorResolver, type Room, createRoom } from "./room.ts";
import { type TagSizer, createTagSizer, growBoxes, separateBoxes, spreadTags } from "./tags.ts";
import { OFFICE_THEME, themeOf } from "./themes.ts";
import { viewKeyOf } from "./view.ts";

export interface OfficeSceneProps {
  /** 部屋に置く社員と今の状態 */
  people: readonly StaffOverview[];
  /** 見せる出来事のまとまり */
  batch: EventBatch | null;
  /** 動かすか。動かさない時は歩かずに置き換え、息や打鍵も止める */
  moves: boolean;
  /** 部屋を組めなかった時か、描く所を失った時に呼ぶ。2D の一覧に代える */
  onFail: () => void;
  /** 部屋の右上に、元の視点に戻すボタンの前に並べるボタン (動きを止めるボタン) */
  tools: ReactNode;
  /** 部屋の下に置く物 (読めなかった知らせと、直近の出来事) */
  children: ReactNode;
}

/** 押せる大きさのトークンが読めない時の大きさ (CSS のピクセル) */
const HIT_SIZE = 44;

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
 * @param labels 社員の id ごとの名札
 * @param sizer 名札の大きさを覚えて返す物。字が変わった時だけ測る
 * @param hitSize 押せる大きさ (CSS のピクセル)
 * @returns 重ねる関数
 */
function placer(room: Room, links: ReadonlyMap<string, HTMLAnchorElement>, labels: ReadonlyMap<string, HTMLAnchorElement>, sizer: TagSizer, hitSize: number): () => void {
  const written = new Map<string, string>();
  return () => {
    const boxes = room.boxes();
    const tags = boxes.flatMap((b) => {
      const tag = labels.get(b.id)?.firstElementChild;
      if (!(tag instanceof HTMLElement)) return [];
      const { width, height } = sizer.sizeOf(b.id, tag.textContent);
      return [{ id: b.id, x: b.left + b.width / 2, bottom: b.top, width, height }];
    });
    // リンクは押せる大きさに広げてから重ならないように削る。名札は姿の箱の上に置き、ほかの名札とほかの社員のリンクを避ける
    const separated = separateBoxes(growBoxes(boxes, hitSize));
    const shift = spreadTags(tags, separated);
    const hits = new Map(separated.map((h) => [h.id, h]));
    for (const b of boxes) {
      const a = links.get(b.id);
      const h = hits.get(b.id);
      if (!a || !h) continue;
      const style = [h.left, h.top, h.width, h.height, b.left, b.top, b.width, b.height, shift[b.id] ?? 0].map(Math.round).join("|");
      if (written.get(b.id) === style) continue;
      written.set(b.id, style);
      a.style.transform = `translate(${Math.round(h.left)}px, ${Math.round(h.top)}px)`;
      a.style.width = `${Math.round(h.width)}px`;
      a.style.height = `${Math.round(h.height)}px`;
      const label = labels.get(b.id);
      if (!label) continue;
      label.style.transform = `translate(${Math.round(b.left)}px, ${Math.round(b.top)}px)`;
      label.style.width = `${Math.round(b.width)}px`;
      label.style.height = `${Math.round(b.height)}px`;
      label.style.setProperty("--ko-tag-shift", `${Math.round(shift[b.id] ?? 0)}px`);
    }
  };
}

/**
 * オフィスの 3D の部屋
 * @param props 部屋に置く社員、出来事、動かすか、組めなかった時の呼び先、右上のボタン、部屋の下に置く物
 * @returns 部屋と、社員のリンク
 */
export default function OfficeScene({ people, batch, moves, onFail, tools, children }: OfficeSceneProps) {
  const frame = useRef<HTMLDivElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const labels = useRef(new Map<string, HTMLAnchorElement>());
  const control = useRef<Control | null>(null);
  const played = useRef(0);
  // 部屋は開いた時に 1 回だけ組む。後の変わりは出来事の動きで見せるので、組む時は初めに受けた出来事の前の状態から始める
  const first = useRef(people.map((s) => ({ id: s.id, state: batch?.before.staff.find((b) => b.id === s.id)?.state ?? s.state })));
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
      const seats = first.current.map((s) => ({ id: s.id, state: roomStateOf(s.state) }));
      // 視点が変わったら、社員のリンクの箱を姿に合わせ直す。部屋を組み終える前は合わせる物が無い
      room = createRoom(el, seats, themeOf(OFFICE_THEME), colorResolver(box), { moves: initialMoves.current, onLost: onFail, onView: () => control.current?.place() });
    } catch {
      el.remove();
      onFail();
      return undefined;
    }
    // 名札は字が変わった時だけ測る。字の形を変える字体の読み込みと画面の大きさの変わりでは測り直す
    const sizer = createTagSizer((id) => {
      const tag = labels.current.get(id)?.firstElementChild;
      return tag instanceof HTMLElement ? { width: tag.offsetWidth, height: tag.offsetHeight } : { width: 0, height: 0 };
    });
    // 押せる大きさはトークンから読む。CSS の最小の大きさで広げると、削った箱が隣に掛かる
    const hitSize = Number.parseFloat(getComputedStyle(box).getPropertyValue("--size-hit")) || HIT_SIZE;
    const place = placer(room, links.current, labels.current, sizer, hitSize);
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
    c.room.setStates(people.map((s) => ({ id: s.id, state: roomStateOf(s.state) })));
    c.place();
  }, [batch, people, moves]);

  useEffect(() => {
    const c = control.current;
    if (!c) return;
    c.room.setStates(people.map((s) => ({ id: s.id, state: roomStateOf(s.state) })));
    c.place();
  }, [people]);

  // 部屋の枠に移った時だけ、矢印で回し、+ と - で寄せ引きする。社員のリンクの上の矢印は奪わない
  const steer = (e: KeyboardEvent<HTMLDivElement>) => {
    const c = control.current;
    const key = viewKeyOf(e.key);
    if (!c || !key || e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if ("zoom" in key) c.room.zoomView(key.zoom);
    else c.room.rotateView(key.turn, key.tilt);
  };

  return (
    <Stack as="section" gap={3} className="ko-office-room" aria-label="オフィスの部屋" data-motion={moves ? "moving" : "still"}>
      <Stack direction="row" gap={2} justify="end" wrap>
        {tools}
        <Button variant="secondary" onClick={() => control.current?.room.resetView()}>
          元の視点に戻す
        </Button>
      </Stack>
      {/* 枠に移ると矢印と + と - で視点を動かせる。canvas は読み上げに出さないので、枠で受ける */}
      <div className="ko-office-frame" ref={frame} role="group" aria-label="部屋の視点" aria-describedby="ko-office-view-help" tabIndex={0} onKeyDown={steer}>
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
            <span className="ko-office-name">
              {s.role} {STAFF_STATES[s.state].label}
            </span>
          </a>
        ))}
        {/* 名札は姿を覆う箱より後ろに並べ、ほかの社員の箱に隠れず押せるようにする。読み上げとキーボードは姿を覆う箱で受ける */}
        {people.map((s) => (
          <a
            key={s.id}
            className="ko-office-label"
            href={`/staff/${s.id}`}
            data-state={s.state}
            aria-hidden="true"
            tabIndex={-1}
            ref={(a) => {
              if (a) labels.current.set(s.id, a);
              else labels.current.delete(s.id);
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
      <p id="ko-office-view-help">部屋をドラッグして回し、ホイールかピンチで寄せ引きできます。部屋を選んで、矢印で回し、+ と - で寄せ引きもできます</p>
    </Stack>
  );
}
