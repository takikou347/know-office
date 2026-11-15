// オフィスのフロアの配置。部屋の定義を廊下の奥と手前の 2 列に並べ、席と待つ所を決め、壁と家具を避けて部屋と廊下をまたぐ道を決める
import type { Staff } from "../../mock.ts";
import { type DeskSeat, type Furniture, OFFICE_ROOMS, type Point, type RoomDef, type Spot } from "./rooms.ts";

export type { DeskSeat, Furniture, FurnitureKind, Point, Spot } from "./rooms.ts";

/** 廊下の区画の名前 */
export const HALL = "hall";
/** 廊下の奥行き (タイルの数) */
const HALL_DEPTH = 1;

/** フロアに置いた部屋。x と z は部屋の左奥の角のタイル */
export interface PlacedRoom {
  def: RoomDef;
  x: number;
  z: number;
}

/** フロアに置いた家具。位置はフロアのタイルで、room は置いた部屋の id */
export interface PlacedFurniture extends Furniture {
  room: string;
}

/** 部屋を並べたフロア */
export interface Floor {
  /** 横と縦のタイルの数 */
  cols: number;
  rows: number;
  /** 廊下の行 (奥の端のタイル) */
  hallZ: number;
  rooms: PlacedRoom[];
  furniture: PlacedFurniture[];
  /** 社員の id ごとの机の席と渡す所 */
  seats: Record<string, DeskSeat>;
  /** 社員の id ごとの待つ時のおすわりの所 */
  rest: Record<string, Spot>;
  /** タイルのある区画 (部屋の id か廊下) を返す。フロアの外は null */
  areaAt: (x: number, z: number) => string | null;
  /** タイルが家具で塞がれているか、フロアの外かを返す */
  isBlocked: (x: number, z: number) => boolean;
  /** 隣のタイルへ 1 歩で移れるかを返す。部屋と廊下の間は出入り口でだけ移れる */
  canStep: (a: Point, b: Point) => boolean;
  /** 壁と家具を避けて歩く一番短い道を返す。始めと終わりの点を含む */
  route: (from: Point, to: Point) => Point[];
}

const key = (x: number, z: number) => `${x},${z}`;
const edge = (a: Point, b: Point) => [key(a.x, a.z), key(b.x, b.z)].toSorted().join("|");
const widthOf = (list: readonly RoomDef[]) => list.reduce((sum, d) => sum + d.size.w, 0);
const shift = (p: Spot, room: PlacedRoom): Spot => ({ x: p.x + room.x, z: p.z + room.z, face: p.face });

/**
 * 点のあるタイルを返す
 * @param p 床の上の点
 * @returns タイルの列と行
 */
export function tileOf(p: Point): Point {
  return { x: Math.floor(p.x), z: Math.floor(p.z) };
}

/**
 * 部屋の定義をフロアに並べる。奥の列は廊下の奥の端にそろえ、手前の列は廊下の手前に置き、どちらも左から定義の順に詰める
 * @param defs 部屋の定義の並び
 * @returns 並べたフロア
 * @throws Error 同じ id の部屋がある時
 */
export function arrangeFloor(defs: readonly RoomDef[]): Floor {
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id) || d.id === HALL) throw new Error(`部屋の id ${d.id} が重なる`);
    seen.add(d.id);
  }
  const back = defs.filter((d) => d.side === "back");
  const front = defs.filter((d) => d.side === "front");
  const hallZ = Math.max(0, ...back.map((d) => d.size.d));
  const rows = hallZ + HALL_DEPTH + Math.max(0, ...front.map((d) => d.size.d));
  const cols = Math.max(widthOf(back), widthOf(front));
  const rooms: PlacedRoom[] = [];
  let bx = 0;
  let fx = 0;
  for (const def of defs) {
    if (def.side === "back") {
      rooms.push({ def, x: bx, z: hallZ - def.size.d });
      bx += def.size.w;
    } else {
      rooms.push({ def, x: fx, z: hallZ + HALL_DEPTH });
      fx += def.size.w;
    }
  }

  const areas = new Map<string, string>();
  for (let x = 0; x < cols; x++) for (let z = hallZ; z < hallZ + HALL_DEPTH; z++) areas.set(key(x, z), HALL);
  const doors = new Set<string>();
  const furniture: PlacedFurniture[] = [];
  const seats: Record<string, DeskSeat> = {};
  const rest: Record<string, Spot> = {};
  for (const room of rooms) {
    const { def } = room;
    for (let x = 0; x < def.size.w; x++) for (let z = 0; z < def.size.d; z++) areas.set(key(room.x + x, room.z + z), def.id);
    // 出入り口は廊下の側の壁にあけ、部屋の端のタイルと廊下のタイルをつなぐ
    for (const door of def.doors) {
      const x = room.x + door;
      const inside = def.side === "back" ? room.z + def.size.d - 1 : room.z;
      const outside = def.side === "back" ? inside + 1 : inside - 1;
      doors.add(edge({ x, z: inside }, { x, z: outside }));
    }
    for (const f of def.furniture) furniture.push({ ...f, x: f.x + room.x, z: f.z + room.z, room: def.id });
    for (const [id, s] of Object.entries(def.seats ?? {})) seats[id] = { seat: shift(s.seat, room), handoff: shift(s.handoff, room) };
    for (const [id, s] of Object.entries(def.rest ?? {})) rest[id] = shift(s, room);
  }

  const blocked = new Set(
    furniture.filter((f) => f.blocks).flatMap((f) => Array.from({ length: f.w * f.d }, (_, i) => key(f.x + (i % f.w), f.z + Math.floor(i / f.w)))),
  );
  const areaAt = (x: number, z: number) => areas.get(key(x, z)) ?? null;
  const blockedAt = (x: number, z: number) => areaAt(x, z) === null || blocked.has(key(x, z));
  const passable = (a: Point, b: Point) => {
    const adjacent = Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
    if (!adjacent || blockedAt(a.x, a.z) || blockedAt(b.x, b.z)) return false;
    return areaAt(a.x, a.z) === areaAt(b.x, b.z) || doors.has(edge(a, b));
  };
  const route = (from: Point, to: Point) => shortestPath(from, to, passable);
  return { cols, rows, hallZ, rooms, furniture, seats, rest, areaAt, isBlocked: blockedAt, canStep: passable, route };
}

/**
 * タイルの真ん中を隣へ 1 つずつ進む一番短い道を決める (幅優先の探索)
 * @param from 歩き始める所
 * @param to 歩き終える所
 * @param passable 隣のタイルへ移れるかを返す関数
 * @returns 通る点の並び。始めと終わりの点を含む
 */
function shortestPath(from: Point, to: Point, passable: (a: Point, b: Point) => boolean): Point[] {
  const start = tileOf(from);
  const goal = tileOf(to);
  const prev = new Map<string, Point | null>([[key(start.x, start.z), null]]);
  const queue: Point[] = [start];
  for (let i = 0; i < queue.length && !prev.has(key(goal.x, goal.z)); i++) {
    const here = queue[i];
    if (!here) break;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { x: here.x + dx, z: here.z + dz };
      if (prev.has(key(next.x, next.z)) || !passable(here, next)) continue;
      prev.set(key(next.x, next.z), here);
      queue.push(next);
    }
  }
  const tiles: Point[] = [];
  for (let p: Point | null | undefined = prev.has(key(goal.x, goal.z)) ? goal : null; p; p = prev.get(key(p.x, p.z))) tiles.unshift(p);
  return [{ x: from.x, z: from.z }, ...tiles.map((t) => ({ x: t.x + 0.5, z: t.z + 0.5 })), { x: to.x, z: to.z }];
}

/** 今のフロア */
export const FLOOR: Floor = arrangeFloor(OFFICE_ROOMS);

/** フロアのタイルの数 */
export const GRID = { cols: FLOOR.cols, rows: FLOOR.rows } as const;

/** フロアの家具の並び */
export const FURNITURE: readonly PlacedFurniture[] = FLOOR.furniture;

/** 部屋に置く社員 */
type SeatedId = "president" | "builder" | "reviewer";

/**
 * フロアから社員の席か待つ所を取り出す。部屋の定義に無ければ組む時に気付けるよう投げる
 * @param table 社員の id ごとの所
 * @param what 何の所か
 * @returns 3 人分の所
 * @throws Error 部屋の定義に無い社員がいる時
 */
function pick<T>(table: Readonly<Record<string, T>>, what: string): Record<SeatedId, T> {
  const need = (id: SeatedId) => {
    const v = table[id];
    if (v === undefined) throw new Error(`${id} の${what}が部屋に無い`);
    return v;
  };
  return { president: need("president"), builder: need("builder"), reviewer: need("reviewer") };
}

/** 社員の id ごとの机 */
export const SEATS: Readonly<Record<SeatedId, DeskSeat>> = pick(FLOOR.seats, "席");

/** 休憩所の、社員ごとのおすわりの所 */
const REST: Readonly<Record<SeatedId, Spot>> = pick(FLOOR.rest, "待つ所");

const isSeated = (id: string): id is SeatedId => Object.hasOwn(SEATS, id);

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
export function restSpotOf(id: SeatedId): Spot {
  return REST[id];
}

/**
 * 社員の状態から、フロアの中で居る所を決める。働く時と止めた時は自分の席、待つ時は休憩所、退勤した時は居ない
 * @param id 社員の id
 * @param state 社員の状態
 * @returns 居る所。フロアに居ない時は null
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

/**
 * タイルが家具で塞がれているか、フロアの外かを返す
 * @param x タイルの列
 * @param z タイルの行
 * @returns 歩けない時は true
 */
export function isBlocked(x: number, z: number): boolean {
  return FLOOR.isBlocked(x, z);
}

/**
 * 隣のタイルへ 1 歩で移れるかを返す。部屋と廊下の間は出入り口でだけ移れる
 * @param a 今のタイル
 * @param b 次のタイル
 * @returns 移れる時は true
 */
export function canStep(a: Point, b: Point): boolean {
  return FLOOR.canStep(a, b);
}

/**
 * 壁と家具を避けて、ある所から別の所へ歩く道を決める。部屋と廊下をまたぐ時は出入り口を通る
 * @param from 歩き始める所
 * @param to 歩き終える所
 * @returns 通る点の並び。始めと終わりの点を含む
 */
export function routeBetween(from: Point, to: Point): Point[] {
  return FLOOR.route(from, to);
}
