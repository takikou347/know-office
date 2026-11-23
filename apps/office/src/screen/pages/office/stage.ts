// 部屋の舞台を組む。描く所、明かり、カメラを作り、canvas の大きさと視点の向きに部屋がちょうど収まるようにカメラを合わせる
import { type Color, DirectionalLight, HemisphereLight, OrthographicCamera, PCFSoftShadowMap, Scene, Vector3, WebGLRenderer } from "three";
import { WALL } from "./walls.ts";

/** 画素比の上限。これより細かく描いても見た目はほぼ変わらず、重さだけが増える */
const MAX_PIXEL_RATIO = 1.5;
/** 影の地図の一辺 (画素) */
const SHADOW_SIZE = 1024;

/** 組んだ舞台 */
export interface Stage {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: OrthographicCamera;
  /** カメラが見る中心 */
  target: Vector3;
  sun: DirectionalLight;
  /** canvas の大きさに合わせ、部屋がちょうど収まるようにカメラを合わせる */
  fit: (width: number, height: number) => void;
  /** 視点を回した後に、今の向きで部屋がちょうど収まるようにカメラを合わせ直す */
  frame: () => void;
}

/**
 * 舞台を組む。影は動かない物だけが落とすので、影の地図は頼んだ時だけ描き直す
 * @param canvas 描く canvas
 * @param background 背景の色
 * @param light 明かりの強さ
 * @param light.ambient 空と床の明かりの強さ
 * @param light.sun 日の光の強さ
 * @param grid フロアのタイルの数
 * @param grid.cols 横の数
 * @param grid.rows 縦の数
 * @returns 舞台
 */
export function buildStage(canvas: HTMLCanvasElement, background: Color, light: { ambient: number; sun: number }, grid: { cols: number; rows: number }): Stage {
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
  sun.position.set(grid.cols * 0.75, 9, -2);
  sun.target.position.set(grid.cols / 2, 0, grid.rows / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
  sun.shadow.radius = 4;
  // 影を落とす広さはフロアの広さに合わせ、部屋を足しても端の影が切れないようにする
  const reach = Math.max(grid.cols, grid.rows) * 0.8;
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, far: 40 });
  scene.add(sun, sun.target);

  const target = new Vector3(grid.cols / 2, 0.4, grid.rows / 2);
  // 視点を回しても部屋の外から見るよう、カメラはフロアの対角より十分に離す
  const distance = Math.max(30, Math.hypot(grid.cols, grid.rows) + 10);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, distance * 3);
  // 部屋を壁で仕切るので、低い壁越しに部屋の中が見える高さから見下ろす
  camera.position.copy(target).add(new Vector3(0.45, 1.25, 1).normalize().multiplyScalar(distance));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  const corners: Vector3[] = [];
  for (const x of [-0.2, grid.cols + 0.2]) for (const y of [0, WALL.high]) for (const z of [-0.2, grid.rows + 0.2]) corners.push(new Vector3(x, y, z));
  let size = { width: 1, height: 1 };

  const frame = () => {
    // 部屋の隅を今の目の向きに写し、どの縦横比と向きでも部屋がちょうど収まる広さを決める
    camera.updateMatrixWorld();
    const view = corners.map((c) => c.clone().applyMatrix4(camera.matrixWorldInverse));
    const minX = Math.min(...view.map((v) => v.x));
    const maxX = Math.max(...view.map((v) => v.x));
    const minY = Math.min(...view.map((v) => v.y));
    const maxY = Math.max(...view.map((v) => v.y));
    let w = (maxX - minX) * 1.02;
    let h = (maxY - minY) * 1.02;
    const aspect = size.width / size.height;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    Object.assign(camera, { left: cx - w / 2, right: cx + w / 2, top: cy + h / 2, bottom: cy - h / 2 });
    camera.updateProjectionMatrix();
  };
  const fit = (width: number, height: number) => {
    size = { width, height };
    renderer.setSize(width, height, false);
    frame();
  };
  return { renderer, scene, camera, target, sun, fit, frame };
}
