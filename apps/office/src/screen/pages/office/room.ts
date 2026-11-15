// オフィスの部屋。舞台と子犬の社員を組み (組み立て)、出来事の動きを進め (動き)、状態ごとの形を当てて描き (描画)、閉じる時に捨てる (片付け)
import { Color, type Group, type Mesh, MeshStandardMaterial, type Object3D, Vector3 } from "three";
import type { Staff } from "../../mock.ts";
import { avatarSourceOf } from "./avatars.ts";
import { disposeScene } from "./cleanup.ts";
import { type ActorState, createDirector } from "./director.ts";
import { PROPS, PUPPY_SCALE, applyPuppyPose, buildPuppy, coatOf, puppyScaleFor } from "./figure.ts";
import { furLayersFor } from "./fur.ts";
import { type DeskParts, SEAT_HEIGHT, buildRoomShell, stackPaper } from "./furniture.ts";
import { FLOOR, type Point, seatOf, stationOf } from "./layout.ts";
import { buildMarks, type Marks, showMark } from "./marks.ts";
import { type PuppyClip, type PuppyModel, buildModelPuppy, clipOf, coatIdOf } from "./model.ts";
import { type Pose, activityOf, poseOf } from "./motion.ts";
import type { Actors, Step } from "./plan.ts";
import { buildStage } from "./stage.ts";
import type { OfficeTheme } from "./themes.ts";
import { type VrmAvatar, loadVrmAvatar } from "./vrm.ts";

/** 部屋に置く社員 */
export interface Seat {
  id: string;
  state: Staff["state"];
}

/** 社員の姿を覆う、canvas の中の箱 (CSS のピクセル) */
export interface SeatBox {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 組んだ部屋 */
export interface Room {
  /** 時刻まで動きを進めて描く */
  render: (t: number) => void;
  /** canvas の大きさを変えて描く */
  resize: (width: number, height: number) => void;
  /** 社員の姿を覆う箱を返す */
  boxes: () => SeatBox[];
  /** 社員の今の居る所と、歩けるかを返す */
  actors: () => Actors;
  /** 社員の状態を変える */
  setStates: (seats: readonly Seat[]) => void;
  /** 動きの列を後ろに積む。動かさない間は、その場で置き換える */
  play: (steps: readonly Step[]) => void;
  /** 動かすかを決める。動かさない時は残りの列を置き換え、息や打鍵も止めた形で描く */
  setMoving: (moves: boolean) => void;
  /** 使った物を捨て、描く所を手放す */
  dispose: () => void;
}

/** 色の書き方 (CSS の色か var(--color-...)) を CSS の rgb() に直す関数 */
export type ColorResolver = (value: string) => string;

/** 部屋の決まり */
export interface RoomOptions {
  /** 初めから動かすか */
  moves: boolean;
  /** 描く所を失った時に呼ぶ */
  onLost: () => void;
  /** 子犬のモデル。無ければ形を組んだ子犬にする */
  model: PuppyModel | null;
}

/** 社員の姿。モデルの子犬と形を組んだ子犬で同じ口を持つ */
interface Avatar {
  /** 部屋に置く物 */
  root: Group;
  /** 子犬の姿 (VRM と差し替える時に隠す) */
  body: Object3D;
  /** くわえて運ぶ書類 */
  paper: Mesh;
  /** ある時刻の形を当てる */
  pose: (pose: Pose, clip: PuppyClip, t: number) => void;
  /** 描く毛の層の数を変える。モデルの子犬は毛を模様に焼いてあるので何もしない */
  setFur: (layers: number) => void;
}

/** 3 体の動きの時刻のずらし (ミリ秒)。同じ時にまばたきしないようにする。時刻 0 でどれも目を開けている値にする */
const PHASES = [0, 1100, 2300] as const;

/** 社員の姿と状態 */
interface Figure {
  state: Staff["state"];
  avatar: Avatar;
  marks: Marks;
  vrm?: VrmAvatar;
}

const atSeat = (id: string, p: Point) => {
  const s = seatOf(id)?.seat;
  return s !== undefined && Math.hypot(s.x - p.x, s.z - p.z) < 0.05;
};

/**
 * 部屋を組み、canvas に描く
 * @param canvas 描く canvas
 * @param seats 部屋に置く社員
 * @param theme 部屋の色と明かり
 * @param resolve 色の書き方を CSS の rgb() に直す関数。組む時にだけ呼ぶ
 * @param opts 動かすかと、描く所を失った時の呼び先
 * @returns 組んだ部屋
 */
export function createRoom(canvas: HTMLCanvasElement, seats: readonly Seat[], theme: OfficeTheme, resolve: ColorResolver, opts: RoomOptions): Room {
  // 組み立て: 色はここで 1 回だけ直し、描く間は作った Color を使い回す
  const color = (value: string) => new Color(resolve(value));
  const screenOn = color(theme.screenOn);
  const screenOff = color(theme.screenOff);
  const markColors = { stop: color(theme.stop), ok: color(theme.ok), back: color(theme.back) };
  const materials = new Map<string, MeshStandardMaterial>();
  const mat = (key: string) => {
    const binder = /^binder(\d)$/.exec(key);
    const value: unknown = binder ? theme.binders[Number(binder[1])] : Reflect.get(theme, key);
    if (typeof value !== "string") throw new Error(`${key} は色ではない`);
    let m = materials.get(key);
    if (!m) {
      m = new MeshStandardMaterial({ color: color(value), roughness: 0.85 });
      materials.set(key, m);
    }
    return m;
  };
  const { renderer, scene, camera, sun, fit } = buildStage(canvas, color(theme.background), theme, FLOOR);
  const desks: Record<string, DeskParts> = buildRoomShell(scene, FLOOR, mat, resolve, theme);
  const puppyColors = {
    cream: color(theme.furCream),
    eye: color(theme.eye),
    iris: color(theme.iris),
    nose: color(theme.nose),
    mouth: color(theme.mouth),
    shadow: color(theme.eye),
    gold: color(theme.gold),
    pen: color(theme.pen),
    frame: color(theme.frame),
  };
  const paperMat = mat("paper");
  let disposed = false;
  const figures = new Map<string, Figure>();
  const states = new Map<string, ActorState>();
  const avatarOf = (id: string, index: number): Avatar => {
    const prop = PROPS[id] ?? null;
    if (opts.model) {
      const p = buildModelPuppy(opts.model, coatIdOf(id), prop, puppyColors, paperMat.color, PHASES[index % PHASES.length]);
      return { root: p.root, body: p.body, paper: p.paper, pose: p.apply, setFur: () => undefined };
    }
    const p = buildPuppy({ ...puppyColors, coat: color(coatOf(theme, id)) }, prop, paperMat.color);
    return { root: p.root, body: p.body, paper: p.paper, pose: (pose) => applyPuppyPose(p, pose), setFur: p.setFur };
  };
  for (const [index, s] of seats.entries()) {
    const avatar = avatarOf(s.id, index);
    const marks = buildMarks(markColors);
    avatar.root.add(marks.group);
    scene.add(avatar.root);
    const figure: Figure = { state: s.state, avatar, marks };
    figures.set(s.id, figure);
    const at = stationOf(s.id, s.state);
    states.set(s.id, { id: s.id, pos: at ?? { x: 0, z: 0 }, face: at?.face ?? 0, present: at !== null, carry: false, walking: false, giving: false, mark: null });
    const source = avatarSourceOf(s.id);
    if (source.kind === "vrm") {
      // 読めたら子犬と差し替え、読めなければ子犬のままにする
      loadVrmAvatar(source.url)
        .then((vrm) => {
          if (disposed) return vrm.dispose();
          avatar.body.visible = false;
          avatar.root.add(vrm.object);
          figure.vrm = vrm;
        })
        .catch(() => undefined);
    }
  }
  const paintScreen = (id: string, state: Staff["state"]) => {
    const desk = desks[id];
    if (!desk) return;
    const on = state === "working";
    desk.screen.color.copy(on ? screenOn : screenOff);
    desk.screen.emissive.copy(desk.screen.color);
    desk.screen.emissiveIntensity = on ? 0.7 : 0;
  };
  for (const [id, f] of figures) paintScreen(id, f.state);

  // 動き: 書類を机に置いたら山を足し、影の地図を描き直す
  const director = createDirector(states, (deskId) => {
    const desk = desks[deskId];
    if (!desk) return;
    stackPaper(desk.papers, paperMat);
    renderer.shadowMap.needsUpdate = true;
  });
  let moves = opts.moves;
  let size = { width: 1, height: 1 };
  let scale = PUPPY_SCALE;

  // 描画: 動かさない間は時刻 0 の形 (息、打鍵、しっぽを止めた形) で描く
  const draw = (t: number) => {
    const at = moves ? t : 0;
    for (const [id, f] of figures) {
      const a = states.get(id);
      if (!a) continue;
      const activity = a.walking ? "walk" : activityOf(f.state);
      const pose = a.giving ? poseOf("walk", 0) : poseOf(activity, at);
      const seated = pose.posture === "sit" && atSeat(id, a.pos);
      f.avatar.pose({ ...pose, visible: a.present && (a.walking || pose.visible) }, clipOf(a.giving ? "give" : activity), at);
      f.vrm?.applyPose(pose);
      f.vrm?.update(1 / 30);
      f.avatar.root.position.set(a.pos.x, seated ? SEAT_HEIGHT : 0, a.pos.z);
      f.avatar.root.rotation.y = a.face;
      f.avatar.paper.visible = a.carry;
      // 歩いている間は止めた印を出さない
      const stopMark = a.walking ? null : pose.mark;
      showMark(f.marks, a.mark?.kind ?? stopMark, camera);
    }
    renderer.render(scene, camera);
  };

  // 片付け: 描く所を失ったら 2D に代える。捨てる時に自分で失わせる分は聞かない
  const lost = () => opts.onLost();
  canvas.addEventListener("webglcontextlost", lost);

  return {
    render: (t) => {
      director.advance(t);
      draw(t);
    },
    resize: (width, height) => {
      size = { width: Math.max(1, width), height: Math.max(1, height) };
      fit(size.width, size.height);
      scale = puppyScaleFor(size.width);
      const layers = furLayersFor(size.width);
      for (const f of figures.values()) {
        f.avatar.root.scale.setScalar(scale);
        f.avatar.setFur(layers);
      }
      draw(0);
    },
    boxes: () =>
      [...states.values()].flatMap((a) => {
        // 退勤した社員は、空いた席を覆う
        const seat = seatOf(a.id)?.seat ?? null;
        const at = a.present ? a.pos : seat;
        if (!at) return [];
        const lifted = atSeat(a.id, at) ? SEAT_HEIGHT : 0;
        const toScreen = (y: number) => {
          const v = new Vector3(at.x, y, at.z).project(camera);
          return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
        };
        // 頭の上の印まで覆う
        const top = toScreen(lifted + 1.2 * scale);
        const bottom = toScreen(0);
        const height = bottom.y - top.y;
        const width = Math.max(height * 0.8, 24);
        return [{ id: a.id, left: top.x - width / 2, top: top.y, width, height }];
      }),
    actors: () =>
      Object.fromEntries(
        [...states.values()].map((a) => {
          const state = figures.get(a.id)?.state ?? "off";
          return [a.id, { at: a.present ? (stationOf(a.id, state) ?? null) : null, canMove: a.present && state !== "stopped" }];
        }),
      ),
    setStates: (next) => {
      for (const s of next) {
        const f = figures.get(s.id);
        if (!f || f.state === s.state) continue;
        f.state = s.state;
        paintScreen(s.id, s.state);
      }
      if (moves) return;
      draw(0);
    },
    play: (steps) => {
      director.push(steps);
      if (moves) return;
      // 歩かずに置き換え、印は次の出来事まで出したままにする
      director.settle();
      draw(0);
    },
    setMoving: (next) => {
      moves = next;
      if (next) return;
      director.settle();
      draw(0);
    },
    dispose: () => {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", lost);
      for (const f of figures.values()) f.vrm?.dispose();
      disposeScene(scene, materials.values());
      // 写しは元の形を分け合うので、元のモデルも最後に捨てる
      opts.model?.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
