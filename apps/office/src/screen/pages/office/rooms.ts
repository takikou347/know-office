// オフィスの部屋の定義。部屋は 1 つずつの部品 (id、名前、広さ、家具、席、出入り口) で、並びに足すとフロアに部屋が増える
import type { Furniture, RoomDef } from "@know-office/core";

// 部屋の形は core のスキーマにあり、拡張の部屋は ExtensionRoomDef で確かめてから並べる (layout の arrangeFloor)
export type { DeskSeat, FloorKind, Furniture, FurnitureKind, Point, RoomDef, Spot } from "@know-office/core";

/** 社長室: 奥の窓の前に社長の机、左に本棚、隅に鉢植え */
const PRESIDENT_ROOM: RoomDef = {
  id: "president",
  name: "社長室",
  side: "back",
  size: { w: 4, d: 4 },
  floor: "carpet",
  furniture: [
    { kind: "bookcase", x: 0, z: 0, w: 1, d: 2, blocks: true, rot: Math.PI / 2 },
    { kind: "window", x: 1, z: 0, w: 3, d: 1, blocks: false },
    { kind: "desk-president", x: 1, z: 1, w: 2, d: 1, blocks: true, owner: "president" },
    { kind: "plant", x: 0, z: 3, w: 1, d: 1, blocks: true },
  ],
  seats: { president: { seat: { x: 2, z: 0.6, face: 0 }, handoff: { x: 2, z: 2.5, face: Math.PI } } },
  doors: [3],
};

/** 執務室: 作る役と見る役の机を並べ、奥に書類の棚 */
const WORK_ROOM: RoomDef = {
  id: "work",
  name: "執務室",
  side: "back",
  size: { w: 5, d: 4 },
  floor: "tile",
  furniture: [
    { kind: "desk", x: 1, z: 1, w: 1, d: 1, blocks: true, owner: "builder" },
    { kind: "desk", x: 3, z: 1, w: 1, d: 1, blocks: true, owner: "reviewer" },
    { kind: "shelf", x: 4, z: 0, w: 1, d: 2, blocks: true, rot: -Math.PI / 2 },
    { kind: "plant", x: 4, z: 3, w: 1, d: 1, blocks: true },
  ],
  seats: {
    builder: { seat: { x: 1.5, z: 0.6, face: 0 }, handoff: { x: 1.5, z: 2.5, face: Math.PI } },
    reviewer: { seat: { x: 3.5, z: 0.6, face: 0 }, handoff: { x: 3.5, z: 2.5, face: Math.PI } },
  },
  doors: [2],
};

/** 会議室: 丸い机と椅子 */
const MEETING_ROOM: RoomDef = {
  id: "meeting",
  name: "会議室",
  side: "front",
  size: { w: 4, d: 3 },
  floor: "tile",
  furniture: [
    { kind: "meeting-table", x: 1, z: 1, w: 2, d: 2, blocks: true },
    { kind: "meeting-chair", x: 0, z: 1, w: 1, d: 1, blocks: true, rot: Math.PI / 2 },
    { kind: "meeting-chair", x: 3, z: 1, w: 1, d: 1, blocks: true, rot: -Math.PI / 2 },
    { kind: "plant", x: 3, z: 2, w: 1, d: 1, blocks: true },
  ],
  doors: [0],
};

/** 休憩所: 敷物の上にソファと低い机。待つ社員はここで座る */
const LOUNGE: RoomDef = {
  id: "lounge",
  name: "休憩所",
  side: "front",
  size: { w: 5, d: 3 },
  floor: "tile",
  furniture: [
    { kind: "rug", x: 0, z: 0, w: 5, d: 3, blocks: false },
    { kind: "sofa", x: 4, z: 0, w: 1, d: 2, blocks: true, rot: -Math.PI / 2 },
    { kind: "coffee-table", x: 2, z: 1, w: 1, d: 1, blocks: true },
    { kind: "plant", x: 0, z: 2, w: 1, d: 1, blocks: true },
  ],
  rest: {
    president: { x: 1.5, z: 1.5, face: Math.PI / 2 },
    builder: { x: 3.5, z: 1.5, face: -Math.PI / 2 },
    reviewer: { x: 2.5, z: 0.5, face: 0 },
  },
  doors: [1],
};

/** 最初のフロアの部屋。奥の列は左から社長室と執務室、手前の列は会議室と休憩所 */
export const OFFICE_ROOMS: readonly RoomDef[] = [PRESIDENT_ROOM, WORK_ROOM, MEETING_ROOM, LOUNGE];

/**
 * 家具の塞ぐタイルを並べる
 * @param f 家具
 * @returns 部屋の中のタイルの並び
 */
const tilesOf = (f: Furniture) => Array.from({ length: f.w * f.d }, (_, i) => ({ x: f.x + (i % f.w), z: f.z + Math.floor(i / f.w) }));

/**
 * 1 つの部屋の定義が、フロアに並べられる形かを確かめる。出入り口は廊下の側の幅の中にあって家具で塞がれず、家具は部屋の中に収まる
 * @param def 部屋の定義
 * @throws Error 出入り口が幅の外か家具で塞がれている時、家具が部屋からはみ出す時
 */
function checkRoom(def: RoomDef): void {
  for (const f of def.furniture) {
    const inside = f.x >= 0 && f.z >= 0 && f.x + f.w <= def.size.w && f.z + f.d <= def.size.d;
    if (!inside) throw new Error(`${def.id} の家具 ${f.kind} が部屋からはみ出す`);
  }
  const edge = def.side === "back" ? def.size.d - 1 : 0;
  const blocked = new Set(def.furniture.filter((f) => f.blocks).flatMap((f) => tilesOf(f).map((t) => `${t.x},${t.z}`)));
  for (const door of def.doors) {
    const within = Number.isInteger(door) && door >= 0 && door < def.size.w;
    if (!within) throw new Error(`${def.id} の出入り口 ${door} が部屋の幅の外にある`);
    if (blocked.has(`${door},${edge}`)) throw new Error(`${def.id} の出入り口 ${door} を家具が塞ぐ`);
  }
}

/**
 * 部屋の定義の並びを確かめる。id は 1 つずつで、同じ社員の席と待つ所は 1 つの部屋にだけ置く
 * @param defs 部屋の定義の並び
 * @param reserved 部屋の id に使えない名前 (廊下)
 * @throws Error id が重なる時、同じ社員の席か待つ所が 2 つの部屋にある時、checkRoom が断る時
 */
export function checkRooms(defs: readonly RoomDef[], reserved: string): void {
  const ids = new Set<string>([reserved]);
  const seated = new Set<string>();
  const resting = new Set<string>();
  for (const def of defs) {
    if (ids.has(def.id)) throw new Error(`部屋の id ${def.id} が重なる`);
    ids.add(def.id);
    checkRoom(def);
    for (const id of Object.keys(def.seats ?? {})) {
      if (seated.has(id)) throw new Error(`${id} の席が 2 つの部屋にある`);
      seated.add(id);
    }
    for (const id of Object.keys(def.rest ?? {})) {
      if (resting.has(id)) throw new Error(`${id} の待つ所が 2 つの部屋にある`);
      resting.add(id);
    }
  }
}
