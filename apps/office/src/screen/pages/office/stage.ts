// 部屋の舞台を組む。描く所、明かり、カメラを作り、canvas の大きさに部屋がちょうど収まるようにカメラを合わせる
import { type Color, DirectionalLight, HemisphereLight, OrthographicCamera, PCFSoftShadowMap, Scene, Vector3, WebGLRenderer } from "three";
import { GRID } from "./layout.ts";

/** 画素比の上限。これより細かく描いても見た目はほぼ変わらず、重さだけが増える */
const MAX_PIXEL_RATIO = 1.5;
/** 影の地図の一辺 (画素) */
const SHADOW_SIZE = 1024;

/** 組んだ舞台 */
export interface Stage {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: OrthographicCamera;
  sun: DirectionalLight;
  /** canvas の大きさに合わせ、部屋がちょうど収まるようにカメラを合わせる */
  fit: (width: number, height: number) => void;
}

/**
 * 舞台を組む。影は動かない物だけが落とすので、影の地図は頼んだ時だけ描き直す
 * @param canvas 描く canvas
 * @param background 背景の色
 * @param light 明かりの強さ
 * @param light.ambient 空と床の明かりの強さ
 * @param light.sun 日の光の強さ
 * @returns 舞台
 */
export function buildStage(canvas: HTMLCanvasElement, background: Color, light: { ambient: number; sun: number }): Stage {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const scene = new Scene();
  scene.background = background;

  // 柔らかい光: 空と床の色を混ぜた明かりに、窓の側からの影の柔らかい日の光を足す
  scene.add(new HemisphereLight(0xfffaf0, 0xe8d8c0, light.ambient * 2.2));
  const sun = new DirectionalLight(0xfff4e0, light.sun);
  sun.position.set(GRID.cols * 0.75, 9, -2);
  sun.target.position.set(GRID.cols / 2, 0, GRID.rows / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
  sun.shadow.radius = 4;
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, far: 30 });
  scene.add(sun, sun.target);

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

  const fit = (width: number, height: number) => {
    renderer.setSize(width, height, false);
    let w = (span.maxX - span.minX) * 1.02;
    let h = (span.maxY - span.minY) * 1.02;
    const aspect = width / height;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    const cx = (span.minX + span.maxX) / 2;
    const cy = (span.minY + span.maxY) / 2;
    Object.assign(camera, { left: cx - w / 2, right: cx + w / 2, top: cy + h / 2, bottom: cy - h / 2 });
    camera.updateProjectionMatrix();
  };
  return { renderer, scene, camera, sun, fit };
}
