// three.js でオフィスの部屋を組む。小さな机と椅子を 2 列に並べ、社員の姿を席に置き、状態ごとの形を毎フレーム当てる
import {
  AmbientLight,
  BufferGeometry,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  PointLight,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Staff } from "../../mock.ts";
import { avatarSourceOf } from "./avatars.ts";
import { type ShapeAvatar, applyShapePose, buildShapeAvatar } from "./figure.ts";
import { SEAT_Y, buildChair, buildDesk } from "./furniture.ts";
import { poseOf } from "./motion.ts";
import type { OfficeTheme } from "./themes.ts";
import { type VrmAvatar, loadVrmAvatar } from "./vrm.ts";

/** 席に着く社員 */
export interface Seat {
  /** 社員の id */
  id: string;
  /** 社員の状態 */
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
  /** 使った物を捨てる */
  dispose: () => void;
}

/** 色の書き方 (CSS の色か var(--color-...)) を three.js の色に直す関数 */
export type ColorResolver = (value: string) => string;

// 部屋の大きさ。x は左右、z は手前 (カメラの側) が正
const ROOM = { minX: -3.4, maxX: 3.4, minZ: -2.6, maxZ: 3, wall: 2.6 };
const COLUMNS = [-1.45, 1.45];
const ROWS = [-0.9, 1.5];

/**
 * 部屋を組み、canvas に描く
 * @param canvas 描く canvas
 * @param seats 席に着く社員。机は 2 列に並べ、空いた席も置く
 * @param theme 部屋の色と明かり
 * @param resolve 色の書き方を three.js の色に直す関数
 * @returns 組んだ部屋
 */
export function createRoom(canvas: HTMLCanvasElement, seats: readonly Seat[], theme: OfficeTheme, resolve: ColorResolver): Room {
  const color = (value: string) => new Color(resolve(value));
  const materials = new Map<string, MeshStandardMaterial>();
  const mat = (key: keyof OfficeTheme) => {
    const value = theme[key];
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

  // 床、敷物、奥と左の壁、窓、鉢植え
  const floor = new Mesh(new PlaneGeometry(ROOM.maxX - ROOM.minX, ROOM.maxZ - ROOM.minZ), mat("floor"));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((ROOM.minX + ROOM.maxX) / 2, 0, (ROOM.minZ + ROOM.maxZ) / 2);
  floor.receiveShadow = true;
  const rug = new Mesh(new PlaneGeometry(5.6, 4), mat("rug"));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.005, 0.25);
  rug.receiveShadow = true;
  const back = new Mesh(new BoxGeometry(ROOM.maxX - ROOM.minX, ROOM.wall, 0.1), mat("wall"));
  back.position.set((ROOM.minX + ROOM.maxX) / 2, ROOM.wall / 2, ROOM.minZ - 0.05);
  back.receiveShadow = true;
  const left = new Mesh(new BoxGeometry(0.1, ROOM.wall, ROOM.maxZ - ROOM.minZ), mat("wall"));
  left.position.set(ROOM.minX - 0.05, ROOM.wall / 2, (ROOM.minZ + ROOM.maxZ) / 2);
  left.receiveShadow = true;
  const windowMat = new MeshStandardMaterial({ color: color(theme.window), emissive: color(theme.window), emissiveIntensity: 0.35 });
  const win = new Mesh(new PlaneGeometry(2.4, 1.1), windowMat);
  win.position.set(0.6, 1.55, ROOM.minZ + 0.001);
  const pot = new Mesh(new CylinderGeometry(0.22, 0.17, 0.4, 16), mat("pot"));
  pot.position.set(ROOM.maxX - 0.45, 0.2, ROOM.minZ + 0.45);
  const leaves = new Mesh(new SphereGeometry(0.4, 16, 12), mat("plant"));
  leaves.position.set(ROOM.maxX - 0.45, 0.75, ROOM.minZ + 0.45);
  for (const m of [pot, leaves]) m.castShadow = true;
  scene.add(floor, rug, back, left, win, pot, leaves);

  scene.add(new AmbientLight(0xffffff, theme.ambient * 2));
  const sun = new DirectionalLight(0xffffff, theme.sun);
  sun.position.set(-2.5, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
  scene.add(sun);

  // 机は 2 列。社員の数が半端なら空いた席を足して並びをそろえる
  const deskCount = Math.max(4, seats.length + (seats.length % 2));
  const staffColors = theme.staff.map(color);
  const placed: {
    seat: Seat | undefined;
    at: Vector3;
    avatar?: ShapeAvatar;
    vrm?: VrmAvatar;
    screen: MeshStandardMaterial;
    bulb: MeshStandardMaterial;
    glow?: PointLight;
  }[] = [];
  const screenOn = color(theme.screenOn);
  const screenOff = color(theme.screenOff);
  const lampOn = color(theme.lamp);
  let disposed = false;
  for (let i = 0; i < deskCount; i++) {
    const x = COLUMNS[i % COLUMNS.length] ?? 0;
    const z = ROWS[Math.floor(i / COLUMNS.length) % ROWS.length] ?? 0;
    const { desk, screen, bulbMat, bulbAt } = buildDesk(mat);
    desk.position.set(x, 0, z);
    scene.add(desk);
    // 椅子と人は机の奥に置き、顔をカメラに向ける
    const at = new Vector3(x, 0, z - 0.6);
    const chair = buildChair(mat);
    chair.position.copy(at);
    scene.add(chair);
    const seat = seats[i];
    const entry: (typeof placed)[number] = { seat, at, screen, bulb: bulbMat };
    if (theme.lampGlow > 0) {
      const glow = new PointLight(lampOn, theme.lampGlow, 2.2, 1.5);
      glow.position.copy(bulbAt).add(desk.position);
      scene.add(glow);
      entry.glow = glow;
    }
    if (seat) {
      const avatar = buildShapeAvatar({
        body: staffColors[i % staffColors.length] ?? new Color(0x888888),
        face: color(theme.face),
        eye: color(theme.eye),
        stop: color(theme.stop),
      });
      avatar.root.position.copy(at);
      scene.add(avatar.root);
      entry.avatar = avatar;
      const source = avatarSourceOf(seat.id);
      if (source.kind === "vrm") {
        // 読めたら形の姿と差し替え、読めなければ形の姿のままにする
        loadVrmAvatar(source.url)
          .then((vrm) => {
            if (disposed) return vrm.dispose();
            vrm.object.position.copy(at);
            scene.add(vrm.object);
            avatar.body.visible = false;
            entry.vrm = vrm;
          })
          .catch(() => undefined);
      }
    }
    placed.push(entry);
  }

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const target = new Vector3(0, 0.6, 0.3);
  camera.position.copy(target).add(new Vector3(5.5, 7, 10).normalize().multiplyScalar(30));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  // 部屋の隅を目の向きに写し、どの縦横比でも部屋がちょうど収まる広さを決める
  const corners: Vector3[] = [];
  for (const x of [ROOM.minX, ROOM.maxX]) for (const y of [0, ROOM.wall]) for (const z of [ROOM.minZ, ROOM.maxZ]) corners.push(new Vector3(x, y, z));
  const view = corners.map((c) => c.clone().applyMatrix4(camera.matrixWorldInverse));
  const span = {
    minX: Math.min(...view.map((v) => v.x)),
    maxX: Math.max(...view.map((v) => v.x)),
    minY: Math.min(...view.map((v) => v.y)),
    maxY: Math.max(...view.map((v) => v.y)),
  };
  let size = { width: 1, height: 1 };

  let last = 0;
  const room: Room = {
    render: (t) => {
      const seconds = last ? (t - last) / 1000 : 0;
      last = t;
      for (const p of placed) {
        const pose = p.seat ? poseOf(p.seat.state, t) : poseOf("off", t);
        if (p.avatar) applyShapePose(p.avatar, pose);
        if (p.vrm) {
          p.vrm.applyPose(pose);
          p.vrm.update(seconds);
          if (p.avatar) p.avatar.body.visible = false;
        }
        p.screen.color.copy(pose.lamp ? screenOn : screenOff);
        p.screen.emissive.copy(pose.lamp ? screenOn : screenOff);
        p.screen.emissiveIntensity = pose.lamp ? 0.8 : 0;
        p.bulb.color.copy(lampOn);
        p.bulb.emissive.copy(lampOn);
        p.bulb.emissiveIntensity = pose.lamp ? 1 : 0;
        if (p.glow) p.glow.visible = pose.lamp;
      }
      renderer.render(scene, camera);
    },
    resize: (width, height) => {
      size = { width: Math.max(1, width), height: Math.max(1, height) };
      renderer.setSize(size.width, size.height, false);
      const margin = 0.06;
      let w = (span.maxX - span.minX) * (1 + margin);
      let h = (span.maxY - span.minY) * (1 + margin);
      const aspect = size.width / size.height;
      if (w / h < aspect) w = h * aspect;
      else h = w / aspect;
      const cx = (span.minX + span.maxX) / 2;
      const cy = (span.minY + span.maxY) / 2;
      Object.assign(camera, { left: cx - w / 2, right: cx + w / 2, top: cy + h / 2, bottom: cy - h / 2 });
      camera.updateProjectionMatrix();
    },
    boxes: () =>
      placed.flatMap((p) => {
        if (!p.seat) return [];
        const toScreen = (y: number) => {
          const v = new Vector3(p.at.x, y, p.at.z).project(camera);
          return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
        };
        const top = toScreen(SEAT_Y + 1.3);
        const bottom = toScreen(0.1);
        const height = bottom.y - top.y;
        const width = height * 0.7;
        return [{ id: p.seat.id, left: top.x - width / 2, top: top.y, width, height }];
      }),
    dispose: () => {
      disposed = true;
      scene.traverse((o: Object3D) => {
        if (!(o instanceof Mesh)) return;
        const geometry: unknown = o.geometry;
        const material: unknown = o.material;
        if (geometry instanceof BufferGeometry) geometry.dispose();
        if (material instanceof Material) material.dispose();
      });
      for (const p of placed) p.vrm?.dispose();
      renderer.dispose();
    },
  };
  return room;
}
