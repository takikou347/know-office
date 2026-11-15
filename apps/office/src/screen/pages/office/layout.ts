// オフィスの部屋の配置。タイル (1 マス = 1) の上に家具、席、渡す所、休憩所を置き、家具を避けて歩く道を決める
import type { Staff } from "../../mock.ts";

/** 床の上の点 (タイルの単位)。x は右、z は手前が正 */
export interface Point {
  x: number;
  z: number;
}

/** 社員が立つか座る所 */
export interface Spot extends Point {
  /** 向き (y 軸の回りのラジアン)。0 で手前を向く */
  face: number;
}

/** 家具の種類 */
export type FurnitureKind =
  | "desk-president"
  | "desk"
  | "meeting-table"
  | "meeting-chair"
  | "shelf"
  | "sofa"
  | "coffee-table"
  | "rug"
  | "plant";

/** 1 つの家具。x と z は左奥の角のタイル、w と d は幅と奥行きのタイルの数 */
export interface Furniture {
  kind: FurnitureKind;
  x: number;
  z: number;
  w: number;
  d: number;
  /** 歩く道を塞ぐか */
  blocks: boolean;
  /** 向き (y 軸の回りのラジアン) */
  rot?: number;
}

/** 床のタイルの数 */
export const GRID = { cols: 10, rows: 8 } as const;

/** 家具の並び */
export const FURNITURE: readonly Furniture[] = [
  // 奥の壁の左に書類の棚
  { kind: "shelf", x: 0, z: 0, w: 3, d: 1, blocks: true },
  // 社長の机は奥の真ん中
  { kind: "desk-president", x: 4, z: 1, w: 2, d: 1, blocks: true },
  // 作る役と見る役の机は左手前に並べる
  { kind: "desk", x: 1, z: 4, w: 1, d: 1, blocks: true },
  { kind: "desk", x: 3, z: 4, w: 1, d: 1, blocks: true },
  // 会議の机は右奥
  { kind: "meeting-table", x: 7, z: 1, w: 2, d: 2, blocks: true },
  { kind: "meeting-chair", x: 7, z: 0, w: 1, d: 1, blocks: true },
  { kind: "meeting-chair", x: 8, z: 0, w: 1, d: 1, blocks: true },
  { kind: "meeting-chair", x: 7, z: 3, w: 1, d: 1, blocks: true, rot: Math.PI },
  { kind: "meeting-chair", x: 8, z: 3, w: 1, d: 1, blocks: true, rot: Math.PI },
  // 休憩所は右手前。敷物の上にソファと低い机
  { kind: "rug", x: 6, z: 5, w: 4, d: 3, blocks: false },
  { kind: "sofa", x: 9, z: 5, w: 1, d: 2, blocks: true, rot: -Math.PI / 2 },
  { kind: "coffee-table", x: 7, z: 6, w: 1, d: 1, blocks: true },
  { kind: "plant", x: 0, z: 7, w: 1, d: 1, blocks: true },
  { kind: "plant", x: 9, z: 0, w: 1, d: 1, blocks: true },
];

/** 社員の机の席と、机の手前の書類を渡す所 */
export interface DeskSeat {
  seat: Spot;
  handoff: Spot;
}

/** 社員の id ごとの机 */
export const SEATS: Readonly<Record<"president" | "builder" | "reviewer", DeskSeat>> = {
  president: { seat: { x: 5, z: 0.6, face: 0 }, handoff: { x: 5, z: 2.5, face: Math.PI } },
  builder: { seat: { x: 1.5, z: 3.6, face: 0 }, handoff: { x: 1.5, z: 5.5, face: Math.PI } },
  reviewer: { seat: { x: 3.5, z: 3.6, face: 0 }, handoff: { x: 3.5, z: 5.5, face: Math.PI } },
};

/** 休憩所の低い机の回りの、社員ごとのおすわりの所 */
const REST: Readonly<Record<keyof typeof SEATS, Spot>> = {
  president: { x: 6.5, z: 6.5, face: Math.PI / 2 },
  builder: { x: 8.5, z: 6.5, face: -Math.PI / 2 },
  reviewer: { x: 7.5, z: 5.5, face: 0 },
};

const isSeated = (id: string): id is keyof typeof SEATS => Object.hasOwn(SEATS, id);

/**
 * 社員の机を返す
 * @param id 社員の id
 * @returns 机の席と渡す所。机の無い社員は null
 */
export function seatOf(id: string): DeskSeat | null {
  return isSeated(id) ? SEATS[id] : null;
}

/**
 * 休憩所の、その社員のおすわりの所を返す
 * @param id 社員の id (社長、作る役、見る役)
 * @returns おすわりの所
 */
export function restSpotOf(id: keyof typeof SEATS): Spot {
  return REST[id];
}

/**
 * 社員の状態から、部屋の中で居る所を決める。働く時と止めた時は自分の席、待つ時は休憩所、退勤した時は居ない
 * @param id 社員の id
 * @param state 社員の状態
 * @returns 居る所。部屋に居ない時は null
 */
export function stationOf(id: string, state: Staff["state"]): Spot | null {
  if (!isSeated(id)) return null;
  switch (state) {
    case "working":
    case "stopped":
      return SEATS[id].seat;
    case "paused":
      return REST[id];
    case "off":
      return null;
    default:
      return state satisfies never;
  }
}

const blockedTiles = new Set(
  FURNITURE.filter((f) => f.blocks).flatMap((f) => Array.from({ length: f.w * f.d }, (_, i) => `${f.x + (i % f.w)},${f.z + Math.floor(i / f.w)}`)),
);

/**
 * タイルが家具で塞がれているか、部屋の外かを返す
 * @param x タイルの列
 * @param z タイルの行
 * @returns 歩けない時は true
 */
export function isBlocked(x: number, z: number): boolean {
  return x < 0 || z < 0 || x >= GRID.cols || z >= GRID.rows || blockedTiles.has(`${x},${z}`);
}

/**
 * 点のあるタイルを返す
 * @param p 床の上の点
 * @returns タイルの列と行
 */
export function tileOf(p: Point): Point {
  return { x: Math.min(GRID.cols - 1, Math.floor(p.x)), z: Math.min(GRID.rows - 1, Math.floor(p.z)) };
}

/**
 * 家具を避けて、ある所から別の所へ歩く道を決める。タイルの真ん中を隣へ 1 つずつ進む一番短い道
 * @param from 歩き始める所
 * @param to 歩き終える所
 * @returns 通る点の並び。始めと終わりの点を含む
 */
export function routeBetween(from: Point, to: Point): Point[] {
  const start = tileOf(from);
  const goal = tileOf(to);
  const key = (p: Point) => `${p.x},${p.z}`;
  const prev = new Map<string, Point | null>([[key(start), null]]);
  const queue: Point[] = [start];
  for (let i = 0; i < queue.length && !prev.has(key(goal)); i++) {
    const here = queue[i];
    if (!here) break;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { x: here.x + dx, z: here.z + dz };
      if (prev.has(key(next)) || isBlocked(next.x, next.z)) continue;
      prev.set(key(next), here);
      queue.push(next);
    }
  }
  const tiles: Point[] = [];
  for (let p: Point | null | undefined = prev.has(key(goal)) ? goal : null; p; p = prev.get(key(p))) tiles.unshift(p);
  return [{ x: from.x, z: from.z }, ...tiles.map((t) => ({ x: t.x + 0.5, z: t.z + 0.5 })), { x: to.x, z: to.z }];
}
