// 拡張が足すオフィスの部屋の定義の形を確かめる (画面の全体の 3.2、サービスと拡張の 3.8)
import { describe, expect, it } from "vitest";
import { ExtensionRoomDef, ROOM_FURNITURE_MAX, ROOM_SIZE_MAX, RoomDef } from "../src/index.ts";

/** 形の合う部屋。奥の列に置く、机 1 つと鉢植えの書斎 */
const STUDY = {
  id: "study",
  name: "書斎",
  side: "back",
  size: { w: 3, d: 3 },
  floor: "carpet",
  furniture: [
    { kind: "desk", x: 1, z: 1, w: 1, d: 1, blocks: true },
    { kind: "plant", x: 2, z: 0, w: 1, d: 1, blocks: true, rot: Math.PI / 2 },
  ],
  doors: [0],
};

describe("部屋の定義", () => {
  it("形の合う部屋を受ける", () => {
    expect(RoomDef.parse(STUDY)).toEqual(STUDY);
    expect(ExtensionRoomDef.parse(STUDY)).toEqual(STUDY);
  });

  it("社員の席と待つ所を持つ部屋を受ける", () => {
    const seated = {
      ...STUDY,
      seats: { builder: { seat: { x: 1.5, z: 0.6, face: 0 }, handoff: { x: 1.5, z: 2.5, face: Math.PI } } },
      rest: { reviewer: { x: 0.5, z: 0.5, face: 0 } },
    };
    expect(RoomDef.safeParse(seated).success).toBe(true);
  });

  it("形の違う部屋を断る", () => {
    const bad: unknown[] = [
      null,
      "study",
      { ...STUDY, id: "" },
      { ...STUDY, id: "Study Room" },
      { ...STUDY, name: "" },
      { ...STUDY, name: "あ".repeat(21) },
      { ...STUDY, side: "left" },
      { ...STUDY, floor: "wood" },
      { ...STUDY, size: { w: "3", d: 3 } },
      { ...STUDY, size: { w: 1.5, d: 3 } },
      { ...STUDY, size: { w: 0, d: 3 } },
      { ...STUDY, size: { w: ROOM_SIZE_MAX + 1, d: 3 } },
      { ...STUDY, doors: [] },
      { ...STUDY, doors: [0.5] },
      { ...STUDY, furniture: [{ kind: "bed", x: 0, z: 0, w: 1, d: 1, blocks: true }] },
      { ...STUDY, furniture: [{ kind: "desk", x: -1, z: 0, w: 1, d: 1, blocks: true }] },
      { ...STUDY, furniture: [{ kind: "desk", x: 0, z: 0, w: 1, d: 1 }] },
      { ...STUDY, furniture: [{ kind: "desk", x: 0, z: 0, w: 1, d: 1, blocks: true, rot: Number.NaN }] },
      { ...STUDY, furniture: Array.from({ length: ROOM_FURNITURE_MAX + 1 }, () => ({ kind: "plant", x: 0, z: 0, w: 1, d: 1, blocks: false })) },
      { ...STUDY, seats: { guest: { seat: { x: 0, z: 0, face: 0 }, handoff: { x: 0, z: 0, face: 0 } } } },
      { ...STUDY, rest: { builder: { x: Number.POSITIVE_INFINITY, z: 0, face: 0 } } },
      { ...STUDY, color: "#ff0000" },
    ];
    expect(bad.filter((def) => RoomDef.safeParse(def).success)).toEqual([]);
  });

  it("拡張の部屋は社員の席、待つ所、机の持ち主を持てない", () => {
    const seats = { builder: { seat: { x: 1.5, z: 0.6, face: 0 }, handoff: { x: 1.5, z: 2.5, face: Math.PI } } };
    const rest = { builder: { x: 0.5, z: 0.5, face: 0 } };
    const owned = [{ kind: "desk", x: 1, z: 1, w: 1, d: 1, blocks: true, owner: "builder" }];
    const bad: unknown[] = [
      { ...STUDY, seats },
      { ...STUDY, rest },
      { ...STUDY, furniture: owned },
    ];
    expect(bad.filter((def) => ExtensionRoomDef.safeParse(def).success)).toEqual([]);
  });
});
