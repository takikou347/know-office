// オフィスの部屋の定義。部屋は 1 つずつの部品 (id、名前、広さ、家具、席、出入り口) で、並びに足すとフロアに部屋が増える

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
  | "bookcase"
  | "window"
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
  /** 机の持ち主の社員の id。渡した書類と画面をこの社員の机に出す */
  owner?: string;
}

/** 社員の机の席と、机の手前の書類を渡す所 */
export interface DeskSeat {
  seat: Spot;
  handoff: Spot;
}

/** 部屋の床の張り方 */
export type FloorKind = "tile" | "carpet";

/**
 * 1 つの部屋の定義。中の位置は部屋の左奥の角からのタイルの数で書く。
 * 拡張 (サービスと拡張の 3.8) が部屋を足す時も、この形の定義を並びに足す
 */
export interface RoomDef {
  /** フロアの中で 1 つだけの名前 */
  id: string;
  /** 壁の札に出す名前 */
  name: string;
  /** 廊下の奥の列に置くか、手前の列に置くか */
  side: "back" | "front";
  /** 広さ (タイルの数) */
  size: { w: number; d: number };
  /** 床の張り方 */
  floor: FloorKind;
  /** 家具 */
  furniture: readonly Furniture[];
  /** 社員の id ごとの机の席 */
  seats?: Readonly<Record<string, DeskSeat>>;
  /** 社員の id ごとの、待つ時のおすわりの所 */
  rest?: Readonly<Record<string, Spot>>;
  /** 廊下の側の壁の出入り口。部屋の左の端からの列の番号 */
  doors: readonly number[];
}

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

/** 休憩所: 敷物の上にソファと低い机。待つ社員はここでおすわりする */
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
