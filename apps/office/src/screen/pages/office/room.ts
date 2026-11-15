// three.js でオフィスの部屋を組み、子犬の社員を置き、状態ごとの形と出来事の動きの列を毎フレーム当てる
import {
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Staff } from "../../mock.ts";
import { avatarSourceOf } from "./avatars.ts";
import { COATS, PROPS, PUPPY_SCALE, type Puppy, applyPuppyPose, buildPuppy } from "./figure.ts";
import { type DeskParts, SEAT_HEIGHT, buildRoomShell, stackPaper } from "./furniture.ts";
import { GRID, type Point, seatOf, stationOf } from "./layout.ts";
import { buildMarks, type Marks, showMark } from "./marks.ts";
import { activityOf, poseOf } from "./motion.ts";
import type { Actors, Step } from "./plan.ts";
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
  /** 時刻の形を当てて描く */
  render: (t: number) => void;
  /** canvas の大きさを変える */
  resize: (width: number, height: number) => void;
  /** 社員の姿を覆う箱を返す */
  boxes: () => SeatBox[];
  /** 社員の今の居る所と、歩けるかを返す */
  actors: () => Actors;
  /** 社員の状態を変える */
  setStates: (seats: readonly Seat[]) => void;
  /** 動きの列を後ろに積む。動きを減らす設定では、その場で置き換える */
  play: (steps: readonly Step[]) => void;
  /** 使った物を捨てる */
  dispose: () => void;
}

/** 色の書き方 (CSS の色か var(--color-...)) を CSS の rgb() に直す関数 */
export type ColorResolver = (value: string) => string;

/** 歩く速さ (タイル毎秒) と、書類を置くのに掛ける時間と、印を出す時間 (ミリ秒) */
const WALK_SPEED = 1.8;
const GIVE_MS = 700;
const MARK_MS = 2400;

interface Actor {
  id: string;
  state: Staff["state"];
  puppy: Puppy;
  marks: Marks;
  vrm?: VrmAvatar;
  pos: Point;
  face: number;
  present: boolean;
  carry: boolean;
  walking: boolean;
  mark: { kind: "ok" | "back"; until: number } | null;
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
 * @param resolve 色の書き方を CSS の rgb() に直す関数
 * @param opts 動きの決まり
 * @param opts.reduce 動きを減らす設定か
 * @returns 組んだ部屋
 */
export function createRoom(canvas: HTMLCanvasElement, seats: readonly Seat[], theme: OfficeTheme, resolve: ColorResolver, opts: { reduce: boolean }): Room {
  const color = (value: string) => new Color(resolve(value));
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

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const scene = new Scene();
  scene.background = color(theme.background);
  const desks: Record<string, DeskParts> = buildRoomShell(scene, mat, resolve, theme);

  // 柔らかい光: 空と床の色を混ぜた明かりに、窓の側からの影の柔らかい日の光を足す
  scene.add(new HemisphereLight(0xfffaf0, 0xe8d8c0, theme.ambient * 2.2));
  const sun = new DirectionalLight(0xfff4e0, theme.sun);
  sun.position.set(GRID.cols * 0.75, 9, -2);
  sun.target.position.set(GRID.cols / 2, 0, GRID.rows / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 4;
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, far: 30 });
  scene.add(sun, sun.target);

  const paperMat = mat("paper");
  let disposed = false;
  const actors = new Map<string, Actor>();
  for (const s of seats) {
    const puppy = buildPuppy(COATS[s.id] ?? "#c99a6e", PROPS[s.id] ?? null, paperMat.color);
    const marks = buildMarks({ stop: color(theme.stop), ok: color(theme.ok), back: color(theme.back) });
    puppy.root.add(marks.group);
    scene.add(puppy.root);
    const at = stationOf(s.id, s.state);
    const actor: Actor = { id: s.id, state: s.state, puppy, marks, pos: at ?? { x: 0, z: 0 }, face: at?.face ?? 0, present: at !== null, carry: false, walking: false, mark: null };
    actors.set(s.id, actor);
    const source = avatarSourceOf(s.id);
    if (source.kind === "vrm") {
      // 読めたら子犬と差し替え、読めなければ子犬のままにする
      loadVrmAvatar(source.url)
        .then((vrm) => {
          if (disposed) return vrm.dispose();
          puppy.body.visible = false;
          puppy.root.add(vrm.object);
          actor.vrm = vrm;
        })
        .catch(() => undefined);
    }
  }

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const target = new Vector3(GRID.cols / 2, 0.4, GRID.rows / 2);
  camera.position.copy(target).add(new Vector3(0.55, 0.95, 1).normalize().multiplyScalar(30));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  // 部屋の隅を目の向きに写し、どの縦横比でも部屋がちょうど収まる広さを決める
  const corners: Vector3[] = [];
  for (const x of [-0.2, GRID.cols + 0.2]) for (const y of [0, 2]) for (const z of [-0.2, GRID.rows + 0.2]) corners.push(new Vector3(x, y, z));
  const view = corners.map((c) => c.clone().applyMatrix4(camera.matrixWorldInverse));
  const span = {
    minX: Math.min(...view.map((v) => v.x)),
    maxX: Math.max(...view.map((v) => v.x)),
    minY: Math.min(...view.map((v) => v.y)),
    maxY: Math.max(...view.map((v) => v.y)),
  };
  let size = { width: 1, height: 1 };

  // 動きの列。先頭から 1 段ずつ進める
  const queue: Step[] = [];
  let current: { step: Step; start: number } | null = null;
  const apply = (step: Step, now: number) => {
    const a = actors.get(step.actor);
    if (!a) return;
    if (step.kind === "give") {
      a.carry = false;
      const desk = desks[step.desk];
      if (desk) stackPaper(desk.papers, paperMat);
    } else if (step.kind === "mark") {
      a.mark = { kind: step.mark, until: now + MARK_MS };
    } else if (step.kind === "place") {
      a.present = step.at !== null;
      if (step.at) {
        a.pos = { x: step.at.x, z: step.at.z };
        a.face = step.at.face;
      }
      a.walking = false;
    }
  };
  const advance = (t: number) => {
    for (;;) {
      if (!current) {
        const next = queue.shift();
        if (!next) return;
        current = { step: next, start: t };
        if (next.kind === "walk") {
          const a = actors.get(next.actor);
          if (a) Object.assign(a, { walking: true, carry: next.carry === "paper", present: true });
        }
      }
      const { step, start } = current;
      const a = actors.get(step.actor);
      if (step.kind === "walk" && a) {
        const lengths = step.path.slice(1).map((p, i) => Math.hypot(p.x - (step.path[i]?.x ?? 0), p.z - (step.path[i]?.z ?? 0)));
        let left = ((t - start) / 1000) * WALK_SPEED;
        let i = 0;
        while (i < lengths.length && left > (lengths[i] ?? 0)) left -= lengths[i++] ?? 0;
        if (i >= lengths.length) {
          const end = step.path.at(-1);
          if (end) a.pos = { ...end };
          a.walking = false;
          current = null;
          continue;
        }
        const p0 = step.path[i] ?? a.pos;
        const p1 = step.path[i + 1] ?? a.pos;
        const k = left / (lengths[i] || 1);
        a.pos = { x: p0.x + (p1.x - p0.x) * k, z: p0.z + (p1.z - p0.z) * k };
        a.face = Math.atan2(p1.x - p0.x, p1.z - p0.z);
        return;
      }
      if (step.kind === "give" && a) {
        a.face = Math.PI;
        if (t - start < GIVE_MS) return;
      }
      apply(step, t);
      current = null;
    }
  };

  const draw = (t: number) => {
    for (const a of actors.values()) {
      const activity = a.walking ? "walk" : activityOf(a.state);
      const standing = !a.walking && current?.step.actor === a.id && current.step.kind === "give";
      // 書類を置く間は立ち止まる。動きを減らす設定では時刻 0 の形のままにする
      const pose = standing ? poseOf("walk", 0) : poseOf(activity, opts.reduce ? 0 : t);
      const seated = pose.posture === "sit" && atSeat(a.id, a.pos);
      applyPuppyPose(a.puppy, { ...pose, visible: a.present && (a.walking || pose.visible) });
      a.vrm?.applyPose(pose);
      a.vrm?.update(1 / 60);
      a.puppy.root.position.set(a.pos.x, seated ? SEAT_HEIGHT : 0, a.pos.z);
      a.puppy.root.rotation.y = a.face;
      a.puppy.paper.visible = a.carry;
      if (a.mark && !opts.reduce && t > a.mark.until) a.mark = null;
      const stopMark = pose.mark === "stop" && !a.walking ? "stop" : null;
      showMark(a.marks, a.mark?.kind ?? stopMark, camera);
      const desk = desks[a.id];
      if (desk) {
        const on = a.state === "working";
        desk.screen.color.copy(color(on ? theme.screenOn : theme.screenOff));
        desk.screen.emissive.copy(desk.screen.color);
        desk.screen.emissiveIntensity = on ? 0.7 : 0;
      }
    }
    renderer.render(scene, camera);
  };

  return {
    render: (t) => {
      advance(t);
      draw(t);
    },
    resize: (width, height) => {
      size = { width: Math.max(1, width), height: Math.max(1, height) };
      renderer.setSize(size.width, size.height, false);
      let w = (span.maxX - span.minX) * 1.02;
      let h = (span.maxY - span.minY) * 1.02;
      const aspect = size.width / size.height;
      if (w / h < aspect) w = h * aspect;
      else h = w / aspect;
      const cx = (span.minX + span.maxX) / 2;
      const cy = (span.minY + span.maxY) / 2;
      Object.assign(camera, { left: cx - w / 2, right: cx + w / 2, top: cy + h / 2, bottom: cy - h / 2 });
      camera.updateProjectionMatrix();
      if (opts.reduce) draw(0);
    },
    boxes: () =>
      [...actors.values()].flatMap((a) => {
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
        const top = toScreen(lifted + 1.2 * PUPPY_SCALE);
        const bottom = toScreen(0);
        const height = bottom.y - top.y;
        const width = Math.max(height * 0.8, 24);
        return [{ id: a.id, left: top.x - width / 2, top: top.y, width, height }];
      }),
    actors: () => Object.fromEntries([...actors.values()].map((a) => [a.id, { at: a.present ? (stationOf(a.id, a.state) ?? null) : null, canMove: a.present && a.state !== "stopped" }])),
    setStates: (next) => {
      for (const s of next) {
        const a = actors.get(s.id);
        if (a) a.state = s.state;
      }
      if (opts.reduce) draw(0);
    },
    play: (steps) => {
      if (!opts.reduce) {
        queue.push(...steps);
        return;
      }
      // 歩かずに置き換え、印は次の出来事まで出したままにする
      for (const a of actors.values()) a.mark = null;
      for (const s of steps) apply(s, 0);
      draw(0);
    },
    dispose: () => {
      disposed = true;
      scene.traverse((o: Object3D) => {
        if (!(o instanceof Mesh)) return;
        const geometry: unknown = o.geometry;
        const material: unknown = o.material;
        if (geometry instanceof BufferGeometry) geometry.dispose();
        if (material instanceof MeshStandardMaterial) material.map?.dispose();
        if (material instanceof Material) material.dispose();
      });
      for (const a of actors.values()) a.vrm?.dispose();
      renderer.dispose();
    },
  };
}
