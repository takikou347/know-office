// 部屋の床、壁、家具を three.js の形で組む。タイルの床、奥と左の高い壁、手前と右の低い壁、配置の表の家具
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Scene,
  SphereGeometry,
} from "three";
import { FURNITURE, type Furniture, GRID, SEATS } from "./layout.ts";
import type { OfficeTheme } from "./themes.ts";

/** 席の椅子の座面の高さ */
export const SEAT_HEIGHT = 0.22;
/** 机の天板の高さ */
const DESK_Y = 0.45;
/** 奥と左の壁の高さと、手前と右の低い壁の高さ */
const WALL = { high: 2, low: 0.28, thick: 0.15 };

/** 社員の机の、画面と書類の山 */
export interface DeskParts {
  screen: MeshStandardMaterial;
  papers: Group;
}

/** 部品の名前から材質を返す関数 */
export type MaterialOf = (key: string) => MeshStandardMaterial;

/**
 * 箱を置く
 * @param parent 置く先
 * @param size 幅、高さ、奥行き
 * @param m 材質
 * @param at 真ん中の位置
 * @returns 置いた箱
 */
function box(parent: Group | Scene, size: [number, number, number], m: Material, at: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), m);
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * 形を置く
 * @param parent 置く先
 * @param geometry 形
 * @param m 材質
 * @param at 真ん中の位置
 */
function put(parent: Group, geometry: BufferGeometry, m: Material, at: readonly [number, number, number]): void {
  const mesh = new Mesh(geometry, m);
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
}

/**
 * 市松のタイルと目地を描いた床の模様を作る
 * @param colors 2 色のタイルと目地の CSS の色
 * @returns 床の模様
 */
function floorTexture(colors: { a: string; b: string; grout: string }): CanvasTexture {
  const px = 64;
  const canvas = document.createElement("canvas");
  canvas.width = GRID.cols * px;
  canvas.height = GRID.rows * px;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = colors.grout;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let x = 0; x < GRID.cols; x++) {
      for (let z = 0; z < GRID.rows; z++) {
        ctx.fillStyle = (x + z) % 2 === 0 ? colors.a : colors.b;
        ctx.fillRect(x * px + 2, z * px + 2, px - 4, px - 4);
      }
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  return tex;
}

/**
 * 社員の机を組む。パソコンの画面は座る社員 (奥) に向ける
 * @param f 家具
 * @param mat 材質
 * @param president 社長の大きな机か
 * @returns 机の組と、画面と書類の山
 */
function buildDesk(f: Furniture, mat: MaterialOf, president: boolean): { group: Group; parts: DeskParts } {
  const g = new Group();
  g.position.set(f.x + f.w / 2, 0, f.z + f.d / 2);
  const w = president ? 1.8 : 1;
  const top = president ? mat("deskPresident") : mat("desk");
  box(g, [w, 0.05, 0.7], top, [0, DESK_Y, 0]);
  if (president) box(g, [w - 0.1, DESK_Y - 0.05, 0.05], top, [0, (DESK_Y - 0.05) / 2, 0.3]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) box(g, [0.05, DESK_Y, 0.05], mat("leg"), [x * (w / 2 - 0.06), DESK_Y / 2, z * 0.29]);
  // ノートのパソコン
  box(g, [0.36, 0.02, 0.24], mat("monitor"), [0, DESK_Y + 0.035, -0.08]);
  const lid = box(g, [0.36, 0.24, 0.02], mat("monitor"), [0, DESK_Y + 0.15, -0.2]);
  lid.rotation.x = 0.2;
  const screen = new MeshStandardMaterial({ color: 0xffffff });
  const glass = new Mesh(new PlaneGeometry(0.32, 0.2), screen);
  glass.position.set(0, DESK_Y + 0.15, -0.212);
  glass.rotation.set(-0.2, Math.PI, 0);
  g.add(glass);
  // 机の明かり
  box(g, [0.02, 0.26, 0.02], mat("leg"), [w / 2 - 0.12, DESK_Y + 0.13, -0.2]);
  const bulb = new Mesh(new SphereGeometry(0.06, 14, 10), new MeshStandardMaterial({ color: mat("lamp").color, emissive: mat("lamp").color, emissiveIntensity: 0.6 }));
  bulb.position.set(w / 2 - 0.12, DESK_Y + 0.28, -0.2);
  g.add(bulb);
  // 渡された書類を手前に重ねる
  const papers = new Group();
  papers.position.set(-w / 2 + 0.2, DESK_Y + 0.03, 0.12);
  g.add(papers);
  return { group: g, parts: { screen, papers } };
}

/**
 * 社員の席の椅子を組む。背は座る社員の後ろ (奥) に置く
 * @param x 席の x
 * @param z 席の z
 * @param mat 材質
 * @returns 椅子
 */
function buildChair(x: number, z: number, mat: MaterialOf): Group {
  const g = new Group();
  g.position.set(x, 0, z);
  box(g, [0.4, 0.05, 0.38], mat("chair"), [0, SEAT_HEIGHT - 0.025, 0]);
  box(g, [0.4, 0.34, 0.05], mat("chair"), [0, SEAT_HEIGHT + 0.17, -0.2]);
  box(g, [0.04, SEAT_HEIGHT - 0.05, 0.04], mat("leg"), [0, (SEAT_HEIGHT - 0.05) / 2, 0]);
  return g;
}

/**
 * 配置の表にある家具を 1 つ組む
 * @param f 家具
 * @param mat 材質
 * @returns 家具の組
 */
function buildPiece(f: Furniture, mat: MaterialOf): Group {
  const g = new Group();
  g.position.set(f.x + f.w / 2, 0, f.z + f.d / 2);
  g.rotation.y = f.rot ?? 0;
  switch (f.kind) {
    case "shelf": {
      box(g, [f.w - 0.2, 1.3, 0.38], mat("shelf"), [0, 0.65, -0.25]);
      const binders = ["binder0", "binder1", "binder2"];
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 12; i++) {
          const m = mat(binders[(i + row) % 3] ?? "binder0");
          box(g, [0.16, 0.3, 0.05], m, [-(f.w - 0.5) / 2 + i * 0.21, 0.27 + row * 0.4, -0.04]);
        }
      }
      break;
    }
    case "meeting-table":
      box(g, [0.1, 0.4, 0.1], mat("leg"), [0, 0.2, 0]);
      put(g, new CylinderGeometry(0.85, 0.85, 0.05, 40), mat("desk"), [0, 0.42, 0]);
      for (const x of [-0.35, 0.3]) box(g, [0.2, 0.01, 0.28], mat("paper"), [x, 0.45, 0.1]);
      break;
    case "meeting-chair":
      box(g, [0.36, 0.05, 0.36], mat("chair"), [0, 0.24, 0.1]);
      box(g, [0.36, 0.3, 0.05], mat("chair"), [0, 0.4, -0.08]);
      box(g, [0.04, 0.22, 0.04], mat("leg"), [0, 0.11, 0.1]);
      break;
    case "sofa":
      box(g, [f.d - 0.1, 0.22, 0.7], mat("sofa"), [0, 0.11, 0]);
      box(g, [f.d - 0.1, 0.4, 0.16], mat("sofa"), [0, 0.3, -0.28]);
      for (const x of [-1, 1]) box(g, [0.14, 0.32, 0.7], mat("sofa"), [x * (f.d / 2 - 0.1), 0.16, 0]);
      for (const x of [-0.4, 0.4]) box(g, [0.6, 0.08, 0.5], mat("rug"), [x, 0.26, 0.05]);
      break;
    case "coffee-table":
      put(g, new CylinderGeometry(0.36, 0.36, 0.04, 28), mat("desk"), [0, 0.24, 0]);
      box(g, [0.06, 0.22, 0.06], mat("leg"), [0, 0.11, 0]);
      put(g, new CylinderGeometry(0.05, 0.045, 0.09, 14), mat("pot"), [0.12, 0.3, 0.05]);
      break;
    case "rug": {
      const rug = new Mesh(new BoxGeometry(f.w - 0.2, 0.02, f.d - 0.2), mat("rug"));
      rug.position.y = 0.01;
      rug.receiveShadow = true;
      g.add(rug);
      break;
    }
    case "plant":
      put(g, new CylinderGeometry(0.2, 0.15, 0.36, 16), mat("pot"), [0, 0.18, 0]);
      for (const [x, y, z, r] of [[0, 0.62, 0, 0.26], [0.14, 0.5, 0.1, 0.17], [-0.15, 0.52, -0.05, 0.18], [0.02, 0.84, 0.03, 0.15]] as const) {
        put(g, new SphereGeometry(r, 16, 12), mat("plant"), [x, y, z]);
      }
      break;
    case "desk":
    case "desk-president":
      // 机は社員の部品と一緒に buildDesk で組む
      break;
    default:
      return f.kind satisfies never;
  }
  return g;
}

/**
 * 床、壁、家具を部屋に置く
 * @param scene 置く先
 * @param mat 材質
 * @param css 色の書き方を CSS の rgb() に直す関数
 * @param theme 部屋の色
 * @returns 社員の id ごとの机の部品
 */
export function buildRoomShell(scene: Scene, mat: MaterialOf, css: (value: string) => string, theme: OfficeTheme): Record<string, DeskParts> {
  const floor = new Mesh(
    new PlaneGeometry(GRID.cols, GRID.rows),
    new MeshStandardMaterial({ map: floorTexture({ a: css(theme.floorA), b: css(theme.floorB), grout: css(theme.grout) }), roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(GRID.cols / 2, 0, GRID.rows / 2);
  floor.receiveShadow = true;
  scene.add(floor);
  // 奥と左は高い壁、手前と右は低く切ってジオラマのように中を見せる
  const shell = new Group();
  box(shell, [GRID.cols + WALL.thick, WALL.high, WALL.thick], mat("wall"), [GRID.cols / 2 - WALL.thick / 2, WALL.high / 2, -WALL.thick / 2]);
  box(shell, [WALL.thick, WALL.high, GRID.rows], mat("wall"), [-WALL.thick / 2, WALL.high / 2, GRID.rows / 2]);
  box(shell, [GRID.cols + WALL.thick * 2, WALL.low, WALL.thick], mat("trim"), [GRID.cols / 2, WALL.low / 2, GRID.rows + WALL.thick / 2]);
  box(shell, [WALL.thick, WALL.low, GRID.rows + WALL.thick], mat("trim"), [GRID.cols + WALL.thick / 2, WALL.low / 2, GRID.rows / 2 - WALL.thick / 2]);
  box(shell, [GRID.cols, 0.1, 0.03], mat("trim"), [GRID.cols / 2, 0.05, 0.015]);
  box(shell, [0.03, 0.1, GRID.rows], mat("trim"), [0.015, 0.05, GRID.rows / 2]);
  scene.add(shell);
  const glass = new Color(css(theme.window));
  const win = new Mesh(new PlaneGeometry(2.6, 0.9), new MeshStandardMaterial({ color: glass, emissive: glass, emissiveIntensity: 0.35 }));
  win.position.set(7.9, 1.25, 0.005);
  scene.add(win);
  box(scene, [2.7, 0.06, 0.08], mat("trim"), [7.9, 0.77, 0.04]);

  const desks: Record<string, DeskParts> = {};
  for (const f of FURNITURE) {
    if (f.kind === "desk" || f.kind === "desk-president") {
      const owner = Object.entries(SEATS).find(([, s]) => s.handoff.x >= f.x && s.handoff.x <= f.x + f.w)?.[0];
      const { group, parts } = buildDesk(f, mat, f.kind === "desk-president");
      scene.add(group);
      if (owner) desks[owner] = parts;
      continue;
    }
    scene.add(buildPiece(f, mat));
  }
  for (const { seat } of Object.values(SEATS)) scene.add(buildChair(seat.x, seat.z, mat));
  return desks;
}

/**
 * 机に書類を 1 枚重ねる。山は 4 枚までにする
 * @param papers 書類の山
 * @param m 書類の材質
 */
export function stackPaper(papers: Group, m: Material): void {
  if (papers.children.length >= 4) return;
  const sheet = new Mesh(new BoxGeometry(0.22, 0.012, 0.3), m);
  sheet.position.y = papers.children.length * 0.014;
  sheet.rotation.y = (papers.children.length % 2 === 0 ? 1 : -1) * 0.12;
  sheet.castShadow = true;
  papers.add(sheet);
}
