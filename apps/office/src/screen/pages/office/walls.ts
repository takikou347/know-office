// フロアの床、壁、部屋の名前の札を three.js の形で組む。奥と左の外の壁は高く、ほかの壁は低く切ってジオラマのように中を見せ、出入り口はあける
import { BoxGeometry, type BufferGeometry, CanvasTexture, Color, Mesh, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, type Scene } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Floor } from "./layout.ts";
import type { OfficeTheme } from "./themes.ts";

/** 奥と左の外の壁の高さ、ほかの低い壁の高さ、壁の厚さ */
export const WALL = { high: 1.7, low: 0.32, thick: 0.12 };

/** 色の書き方を CSS の色に直す関数 */
type Css = (value: string) => string;

/** 1 マスの模様の画素の数 */
const PX = 64;

/**
 * 床の模様を作る。タイルは 2 色の市松と目地、敷き詰めは 1 色に細かな毛足のむらを付ける
 * @param w 幅 (タイルの数)
 * @param d 奥行き (タイルの数)
 * @param colors 2 色と目地の CSS の色。敷き詰めは a だけを使う
 * @param carpet 敷き詰めか
 * @returns 床の模様
 */
function floorTexture(w: number, d: number, colors: { a: string; b: string; grout: string }, carpet: boolean): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w * PX;
  canvas.height = d * PX;
  const ctx = canvas.getContext("2d");
  if (ctx && carpet) {
    ctx.fillStyle = colors.a;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 毛足のむらは決まった並びで置き、開くたびに模様が変わらないようにする
    ctx.globalAlpha = 0.06;
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < w * d * 60; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#ffffff" : "#000000";
      ctx.fillRect(Math.floor(next() * canvas.width), Math.floor(next() * canvas.height), 3, 3);
    }
  } else if (ctx) {
    ctx.fillStyle = colors.grout;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        ctx.fillStyle = (x + z) % 2 === 0 ? colors.a : colors.b;
        ctx.fillRect(x * PX + 2, z * PX + 2, PX - 4, PX - 4);
      }
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * 床の板を置く
 * @param scene 置く先
 * @param area 左奥の角と広さ
 * @param area.x 左の端
 * @param area.z 奥の端
 * @param area.w 幅
 * @param area.d 奥行き
 * @param map 模様
 */
function floorPlate(scene: Scene, area: { x: number; z: number; w: number; d: number }, map: CanvasTexture): void {
  const plate = new Mesh(new PlaneGeometry(area.w, area.d), new MeshStandardMaterial({ map, roughness: 0.95 }));
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(area.x + area.w / 2, 0, area.z + area.d / 2);
  plate.receiveShadow = true;
  scene.add(plate);
}

/**
 * 部屋の名前の札を作る
 * @param name 部屋の名前
 * @param colors 札と文字の CSS の色
 * @param colors.bg 札の色
 * @param colors.text 文字の色
 * @returns 札
 */
function sign(name: string, colors: { bg: string; text: string }): Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = colors.text;
    ctx.font = "bold 36px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 128, 34);
  }
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  return new Mesh(new PlaneGeometry(1.5, 0.375), new MeshStandardMaterial({ map, roughness: 0.8 }));
}

/**
 * 区画の境目の壁を、1 マスずつの辺で集める。同じ辺は 1 回だけ、出入り口の辺は除く
 * @param floor フロア
 * @returns 高い壁と低い壁の形
 */
function wallPieces(floor: Floor): { high: BufferGeometry[]; low: BufferGeometry[] } {
  const high: BufferGeometry[] = [];
  const low: BufferGeometry[] = [];
  const done = new Set<string>();
  const t = WALL.thick;
  for (let x = 0; x < floor.cols; x++) {
    for (let z = 0; z < floor.rows; z++) {
      const here = floor.areaAt(x, z);
      if (here === null) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const there = floor.areaAt(x + dx, z + dz);
        const id = `${Math.min(x, x + dx)},${Math.min(z, z + dz)},${dx === 0 ? "h" : "v"}`;
        const open = there === here || done.has(id) || (there !== null && floor.canStep({ x, z }, { x: x + dx, z: z + dz }));
        if (open) continue;
        done.add(id);
        // 外の奥と左の壁だけを高くし、ほかは低く切って中を見せる
        const outerBack = dz === -1 && z === 0;
        const outerLeft = dx === -1 && x === 0;
        const h = outerBack || outerLeft ? WALL.high : WALL.low;
        const g = dz === 0 ? new BoxGeometry(t, h, 1 + t) : new BoxGeometry(1 + t, h, t);
        g.translate(dz === 0 ? x + (dx + 1) / 2 : x + 0.5, h / 2, dz === 0 ? z + 0.5 : z + (dz + 1) / 2);
        (h === WALL.high ? high : low).push(g);
      }
    }
  }
  return { high, low };
}

/**
 * 床、壁、部屋の名前の札を置く
 * @param scene 置く先
 * @param floor フロア
 * @param mat 材質
 * @param css 色の書き方を CSS の色に直す関数
 * @param theme 部屋の色
 */
export function buildFloorShell(scene: Scene, floor: Floor, mat: (key: string) => MeshStandardMaterial, css: Css, theme: OfficeTheme): void {
  const tile = { a: css(theme.floorA), b: css(theme.floorB), grout: css(theme.grout) };
  floorPlate(scene, { x: 0, z: floor.hallZ, w: floor.cols, d: 1 }, floorTexture(floor.cols, 1, { a: css(theme.hallA), b: css(theme.hallB), grout: tile.grout }, false));
  for (const r of floor.rooms) {
    const carpet = r.def.floor === "carpet";
    const colors = carpet ? { ...tile, a: css(theme.carpet) } : tile;
    floorPlate(scene, { x: r.x, z: r.z, w: r.def.size.w, d: r.def.size.d }, floorTexture(r.def.size.w, r.def.size.d, colors, carpet));
  }
  const { high, low } = wallPieces(floor);
  for (const [pieces, key] of [[high, "wall"], [low, "trim"]] as const) {
    const merged = pieces.length > 0 ? mergeGeometries(pieces) : null;
    for (const g of pieces) g.dispose();
    if (!merged) continue;
    const mesh = new Mesh(merged, mat(key));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  // 札は、奥の列の部屋は奥の高い壁の上に、手前の列の部屋は手前の低い壁の外に付け、どちらもカメラに向ける
  const bg = new Color(css(theme.sign)).getStyle();
  for (const r of floor.rooms) {
    const plate = sign(r.def.name, { bg, text: css(theme.signText) });
    const cx = r.x + r.def.size.w / 2;
    const back = r.def.side === "back" && r.z === 0;
    if (back) plate.position.set(cx, WALL.high - 0.24, WALL.thick / 2 + 0.01);
    else plate.position.set(cx, WALL.low / 2 + 0.05, r.z + r.def.size.d + WALL.thick / 2 + 0.01);
    scene.add(plate);
  }
}
