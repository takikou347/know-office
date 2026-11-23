// 部屋の視点。ドラッグ、ホイール、ピンチは OrbitControls で受け、矢印と + と - でも回して寄せ引きし、元の視点へ戻す。回す角と寄せ引きには限りを付ける
import { MathUtils, type OrthographicCamera, Spherical, TOUCH, Vector3 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** 視点の限り。横に回すのは元の向きから左右へ、縦は真上の近くから、壁越しに床を見下ろせる低さまで */
export const VIEW_LIMITS = {
  /** 元の向きから左右へ回せる角 (ラジアン) */
  turn: 0.6,
  /** 真上から測った、いちばん上の角 (ラジアン) */
  minTilt: 0.2,
  /** 真上から測った、いちばん下の角 (ラジアン)。水平 (π/2) より十分上にし、床の下と壁の横へ回らない */
  maxTilt: 1.1,
  /** 引ける限り。1 で部屋がちょうど収まる */
  minZoom: 0.8,
  /** 寄せられる限り */
  maxZoom: 3,
} as const;

/** 矢印 1 回で回す角 (ラジアン) */
const KEY_TURN = 0.1;
/** + と - の 1 回で寄せ引きする倍率 */
const KEY_ZOOM = 1.2;
/** なめらかに戻す長さ (ミリ秒) */
const RESET_MS = 400;

/** 部屋の視点を動かす物 */
export interface View {
  /** 横と縦に回す。限りの外へは出ない */
  rotate: (turn: number, tilt: number) => void;
  /** 寄せ引きする。1 より大きいと寄せる。限りの外へは出ない */
  zoomBy: (factor: number) => void;
  /** 元の視点に戻す。smooth の時は advance で時刻を進めながら戻す */
  reset: (smooth: boolean) => void;
  /** なめらかに戻す途中なら、時刻 (ミリ秒) まで進める */
  advance: (t: number) => void;
  /** 戻す途中なら、すぐに元の視点にする */
  finish: () => void;
  /** 受けていた操作を外す */
  dispose: () => void;
}

/** 視点を動かす物のキー操作 */
export type ViewKey = { turn: number; tilt: number } | { zoom: number } | null;

/**
 * 押したキーから、視点の動かし方を決める。矢印で回し、+ と - で寄せ引きする
 * @param key KeyboardEvent の key
 * @returns 動かし方。視点のキーでなければ null
 */
export function viewKeyOf(key: string): ViewKey {
  switch (key) {
    case "ArrowLeft":
      return { turn: -KEY_TURN, tilt: 0 };
    case "ArrowRight":
      return { turn: KEY_TURN, tilt: 0 };
    case "ArrowUp":
      return { turn: 0, tilt: -KEY_TURN };
    case "ArrowDown":
      return { turn: 0, tilt: KEY_TURN };
    case "+":
    case "=":
      return { zoom: KEY_ZOOM };
    case "-":
    case "_":
      return { zoom: 1 / KEY_ZOOM };
    default:
      return null;
  }
}

/**
 * 視点を動かす物を作る。今のカメラの向きを元の視点として覚える
 * @param camera 動かすカメラ
 * @param canvas ドラッグ、ホイール、ピンチを受ける canvas
 * @param target 見る中心
 * @param onChange 視点が変わった時に呼ぶ
 * @returns 視点を動かす物
 */
export function createView(camera: OrthographicCamera, canvas: HTMLCanvasElement, target: Vector3, onChange: () => void): View {
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  // 作った時の controls は原点を見る向きにしているので、見る中心へ向け直してから元の視点として覚える
  controls.update();
  // 横に動かすと部屋が画面の外へ出るので、回すのと寄せ引きだけにする
  controls.enablePan = false;
  // スマートフォンでは 1 本指を画面の縦の送りに残し、回すのと寄せ引きは 2 本指で受ける。部屋の上でも画面を送れなくならないように
  controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };
  canvas.style.touchAction = "pan-y";
  const home = new Spherical().setFromVector3(camera.position.clone().sub(target));
  controls.minAzimuthAngle = home.theta - VIEW_LIMITS.turn;
  controls.maxAzimuthAngle = home.theta + VIEW_LIMITS.turn;
  controls.minPolarAngle = VIEW_LIMITS.minTilt;
  controls.maxPolarAngle = VIEW_LIMITS.maxTilt;
  controls.minZoom = VIEW_LIMITS.minZoom;
  controls.maxZoom = VIEW_LIMITS.maxZoom;
  controls.saveState();
  controls.addEventListener("change", onChange);

  let back: { from: Spherical; zoom: number; start: number | null } | null = null;
  const offset = new Vector3();
  const place = (s: Spherical, zoom: number) => {
    camera.position.copy(target).add(offset.setFromSpherical(s));
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    camera.lookAt(target);
    camera.updateMatrixWorld();
    onChange();
  };
  const finish = () => {
    back = null;
    controls.reset();
    // reset は向きを直す前にも change を出し、前の向きが controls の覚えと同じだと直した後に出さないので、直した後に知らせ直す
    camera.updateMatrixWorld();
    onChange();
  };

  return {
    rotate: (turn, tilt) => {
      back = null;
      const s = new Spherical().setFromVector3(camera.position.clone().sub(target));
      s.theta = MathUtils.clamp(s.theta + turn, controls.minAzimuthAngle, controls.maxAzimuthAngle);
      s.phi = MathUtils.clamp(s.phi + tilt, controls.minPolarAngle, controls.maxPolarAngle);
      place(s, camera.zoom);
    },
    zoomBy: (factor) => {
      back = null;
      const s = new Spherical().setFromVector3(camera.position.clone().sub(target));
      place(s, MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom));
    },
    reset: (smooth) => {
      if (!smooth) return finish();
      back = { from: new Spherical().setFromVector3(camera.position.clone().sub(target)), zoom: camera.zoom, start: null };
    },
    advance: (t) => {
      if (!back) return;
      back.start ??= t;
      const k = Math.min(1, (t - back.start) / RESET_MS);
      if (k >= 1) return finish();
      // 初めは速く、終わりはゆっくり止まる
      const e = 1 - (1 - k) ** 3;
      const s = new Spherical(
        MathUtils.lerp(back.from.radius, home.radius, e),
        MathUtils.lerp(back.from.phi, home.phi, e),
        MathUtils.lerp(back.from.theta, home.theta, e),
      );
      place(s, MathUtils.lerp(back.zoom, controls.zoom0, e));
    },
    finish: () => {
      if (back) finish();
    },
    dispose: () => {
      controls.removeEventListener("change", onChange);
      controls.dispose();
    },
  };
}
