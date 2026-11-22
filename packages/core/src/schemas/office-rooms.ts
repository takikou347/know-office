// オフィスの部屋の定義の形。画面が中の部屋と拡張の部屋を同じ形で並べ、拡張の部屋は受ける時にこの形で確かめる (画面の全体の 3.2、サービスと拡張の 3.8)
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** 部屋の幅と奥行きの上限 (タイルの数) */
export const ROOM_SIZE_MAX = 10;

/** 1 つの部屋に置ける家具の数の上限 */
export const ROOM_FURNITURE_MAX = 32;

/** 部屋の名前の札に出せる字の数の上限 */
export const ROOM_NAME_MAX = 20;

/** 家具の種類 */
export const FURNITURE_KINDS = ["desk-president", "desk", "meeting-table", "meeting-chair", "shelf", "bookcase", "window", "sofa", "coffee-table", "rug", "plant"] as const;

/** 家具の種類の型 */
export type FurnitureKind = (typeof FURNITURE_KINDS)[number];

/** 部屋の床の張り方 */
export const FLOOR_KINDS = ["tile", "carpet"] as const;

/** 部屋の床の張り方の型 */
export type FloorKind = (typeof FLOOR_KINDS)[number];

const coord = z.number().finite();
const tile = z.number().int().min(0).max(ROOM_SIZE_MAX);
const span = z.number().int().min(1).max(ROOM_SIZE_MAX);

/** 床の上の点 (タイルの単位)。x は右、z は手前が正 */
export const RoomPoint = z.object({ x: coord, z: coord }).strict();

/** 床の上の点の型 */
export type Point = z.infer<typeof RoomPoint>;

/** 社員が立つか座る所。face は y 軸の回りの向き (ラジアン) で、0 で手前を向く */
export const RoomSpot = RoomPoint.extend({ face: coord }).strict();

/** 社員が立つか座る所の型 */
export type Spot = z.infer<typeof RoomSpot>;

/** 社員の机の席と、机の手前の書類を渡す所 */
export const DeskSeat = z.object({ seat: RoomSpot, handoff: RoomSpot }).strict();

/** 社員の机の席と渡す所の型 */
export type DeskSeat = z.infer<typeof DeskSeat>;

const furnitureShape = {
  kind: z.enum(FURNITURE_KINDS),
  x: tile,
  z: tile,
  w: span,
  d: span,
  blocks: z.boolean(),
  rot: coord.optional(),
};

/** 1 つの家具。x と z は部屋の左奥の角からのタイル、w と d は幅と奥行き、blocks は歩く道を塞ぐか、owner は机の持ち主の社員 */
export const Furniture = z.object({ ...furnitureShape, owner: StaffId.optional() }).strict();

/** 1 つの家具の型 */
export type Furniture = z.infer<typeof Furniture>;

const roomShape = {
  id: z.string().regex(/^[a-z][a-z\d]*(?:-[a-z\d]+)*$/),
  name: z.string().min(1).max(ROOM_NAME_MAX),
  side: z.enum(["back", "front"]),
  size: z.object({ w: span, d: span }).strict(),
  floor: z.enum(FLOOR_KINDS),
  doors: z.array(z.number().int()).min(1).max(ROOM_SIZE_MAX),
};

/**
 * 1 つの部屋の定義。中の位置は部屋の左奥の角からのタイルの数で書く。doors は廊下の側の壁の出入り口の列。
 * 出入り口が幅の中か、家具が部屋に収まるか、id が重ならないかは、並べる時に画面が確かめる
 */
export const RoomDef = z
  .object({
    ...roomShape,
    furniture: z.array(Furniture).max(ROOM_FURNITURE_MAX),
    seats: z.partialRecord(StaffId, DeskSeat).optional(),
    rest: z.partialRecord(StaffId, RoomSpot).optional(),
  })
  .strict();

/** 1 つの部屋の定義の型 */
export type RoomDef = z.infer<typeof RoomDef>;

/** 拡張が足す部屋の定義。社員の席、待つ所、机の持ち主を持てず、社員の居場所と机を動かさない */
export const ExtensionRoomDef = z
  .object({
    ...roomShape,
    furniture: z.array(z.object(furnitureShape).strict()).max(ROOM_FURNITURE_MAX),
  })
  .strict();

/** 拡張が足す部屋の定義の型 */
export type ExtensionRoomDef = z.infer<typeof ExtensionRoomDef>;
