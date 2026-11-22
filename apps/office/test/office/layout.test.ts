import { describe, expect, it } from "vitest";
import {
  FLOOR,
  FURNITURE,
  HALL,
  SEATS,
  arrangeFloor,
  canStep,
  isBlocked,
  restSpotOf,
  routeBetween,
  stationOf,
  tileOf,
} from "../../src/screen/pages/office/layout.ts";
import { OFFICE_ROOMS, type RoomDef } from "../../src/screen/pages/office/rooms.ts";

// オフィスのフロアの部屋、席、道の配置。画面の全体の 3.2

const STAFF = ["president", "builder", "reviewer"] as const;

/**
 * 席、渡す所、休憩所の場所をすべて並べる
 * @returns 場所の並び
 */
const allSpots = () => [
  ...STAFF.flatMap((id) => [SEATS[id].seat, SEATS[id].handoff]),
  ...STAFF.map((id) => restSpotOf(id)),
];

describe("家具の配置", () => {
  it("社長、作る役、見る役の机、会議の机、休憩所、書類の棚がある", () => {
    const kinds = new Set(FURNITURE.map((f) => f.kind));
    for (const k of ["desk-president", "desk", "meeting-table", "sofa", "shelf"]) expect(kinds).toContain(k);
    expect(FURNITURE.filter((f) => f.kind === "desk")).toHaveLength(2);
  });

  it("家具は自分の部屋の中にあり、道を塞ぐ家具どうしは重ならない", () => {
    const used = new Set<string>();
    for (const f of FURNITURE) {
      for (let x = f.x; x < f.x + f.w; x++) for (let z = f.z; z < f.z + f.d; z++) expect(FLOOR.areaAt(x, z), `${f.kind} の ${x},${z}`).toBe(f.room);
      if (!f.blocks) continue;
      for (let x = f.x; x < f.x + f.w; x++) {
        for (let z = f.z; z < f.z + f.d; z++) {
          expect(used.has(`${x},${z}`), `${f.kind} が ${x},${z} で重なる`).toBe(false);
          used.add(`${x},${z}`);
        }
      }
    }
  });

  it("席と渡す所と休憩所は家具に重ならず、互いに別の所にある", () => {
    const spots = allSpots();
    for (const s of spots) {
      const t = tileOf(s);
      expect(isBlocked(t.x, t.z), `${s.x},${s.z}`).toBe(false);
    }
    expect(new Set(spots.map((s) => `${s.x},${s.z}`)).size).toBe(spots.length);
  });

  it("渡す所は、その人の机の手前にある", () => {
    for (const id of STAFF) {
      const { seat, handoff } = SEATS[id];
      expect(handoff.z).toBeGreaterThan(seat.z);
      expect(Math.abs(handoff.x - seat.x)).toBeLessThan(0.01);
    }
  });
});

describe("道", () => {
  it("道は始めの所から終わりの所まで、隣のタイルを 1 つずつ進み、家具を通らない", () => {
    const from = SEATS.president.seat;
    const to = SEATS.builder.handoff;
    const path = routeBetween(from, to);
    expect(path[0]).toEqual({ x: from.x, z: from.z });
    expect(path.at(-1)).toEqual({ x: to.x, z: to.z });
    const tiles = path.slice(1, -1).map(tileOf);
    for (const t of tiles) expect(isBlocked(t.x, t.z)).toBe(false);
    for (let i = 1; i < tiles.length; i++) {
      const a = tiles[i - 1];
      const b = tiles[i];
      if (!a || !b) continue;
      expect(Math.abs(a.x - b.x) + Math.abs(a.z - b.z)).toBe(1);
    }
  });

  it("どの場所からどの場所へも道がある", () => {
    const spots = allSpots();
    for (const a of spots) for (const b of spots) expect(routeBetween(a, b).length).toBeGreaterThanOrEqual(3);
  });

  it("塞ぐ物の無い所では回り道をしない", () => {
    const path = routeBetween(SEATS.builder.handoff, SEATS.reviewer.handoff);
    const from = tileOf(SEATS.builder.handoff);
    const to = tileOf(SEATS.reviewer.handoff);
    expect(path.slice(1, -1).map(tileOf)).toEqual(Array.from({ length: to.x - from.x + 1 }, (_, i) => ({ x: from.x + i, z: from.z })));
  });
});

/**
 * 道の通るタイルの並びを返す
 * @param from 歩き始める所
 * @param to 歩き終える所
 * @returns タイルの並び
 */
const tilesOf = (from: { x: number; z: number }, to: { x: number; z: number }) => routeBetween(from, to).slice(1, -1).map(tileOf);

/** 足して確かめる部屋。奥の列の右に、机 1 つと鉢植えの小さな部屋を置く */
const STUDY: RoomDef = {
  id: "study",
  name: "書斎",
  side: "back",
  size: { w: 3, d: 3 },
  floor: "carpet",
  furniture: [
    { kind: "desk", x: 1, z: 1, w: 1, d: 1, blocks: true },
    { kind: "plant", x: 2, z: 0, w: 1, d: 1, blocks: true },
  ],
  doors: [0],
};

/**
 * 点のある区画を返す
 * @param p 床の上の点
 * @returns 部屋の id か廊下
 */
const roomAt = (p: { x: number; z: number }) => FLOOR.areaAt(tileOf(p).x, tileOf(p).z);

describe("オフィスの部屋", () => {
  it("最初のフロアには社長室、執務室、会議室、休憩所があり、廊下でつながる", () => {
    expect(FLOOR.rooms.map((r) => r.def.name)).toEqual(["社長室", "執務室", "会議室", "休憩所"]);
    for (const r of FLOOR.rooms) {
      // 部屋の出入り口のタイルまで歩ける
      const door = r.def.doors[0] ?? 0;
      const inside = { x: r.x + door + 0.5, z: r.z + (r.def.side === "back" ? r.def.size.d - 1 : 0) + 0.5 };
      const path = tilesOf(SEATS.president.seat, inside);
      expect(path.at(-1)).toEqual(tileOf(inside));
    }
  });

  it("社長の席は社長室、作る役と見る役の席は執務室、待つ所は休憩所にある", () => {
    expect(roomAt(SEATS.president.seat)).toBe("president");
    expect(roomAt(SEATS.builder.seat)).toBe("work");
    expect(roomAt(SEATS.reviewer.seat)).toBe("work");
    for (const id of ["president", "builder", "reviewer"] as const) expect(roomAt(restSpotOf(id))).toBe("lounge");
  });

  it("隣り合う部屋の間は壁で、出入り口でだけ廊下とつながる", () => {
    const president = FLOOR.rooms.find((r) => r.def.id === "president");
    const work = FLOOR.rooms.find((r) => r.def.id === "work");
    if (!president || !work) throw new Error("部屋が無い");
    // 社長室の右の端と執務室の左の端は、隣のタイルでも壁で行き来できない
    for (let z = president.z; z < president.z + president.def.size.d; z++) {
      expect(canStep({ x: work.x - 1, z }, { x: work.x, z })).toBe(false);
    }
    // 部屋から廊下へは、出入り口のタイルからだけ出られる
    const edge = president.z + president.def.size.d - 1;
    for (let x = president.x; x < president.x + president.def.size.w; x++) {
      const open = canStep({ x, z: edge }, { x, z: edge + 1 });
      expect(open, `${x}`).toBe(president.def.doors.includes(x - president.x));
    }
  });

  it("仕事を渡す道は、社長室から廊下を通って執務室の机へ行き、家具を通らない", () => {
    const tiles = tilesOf(SEATS.president.seat, SEATS.builder.handoff);
    const areas = tiles.map((t) => FLOOR.areaAt(t.x, t.z));
    expect(areas[0]).toBe("president");
    expect(areas).toContain(HALL);
    expect(areas.at(-1)).toBe("work");
    for (const t of tiles) expect(isBlocked(t.x, t.z), `${t.x},${t.z}`).toBe(false);
    for (let i = 1; i < tiles.length; i++) {
      const a = tiles[i - 1];
      const b = tiles[i];
      if (!a || !b) continue;
      expect(canStep(a, b), `${a.x},${a.z} から ${b.x},${b.z}`).toBe(true);
    }
  });

  it("部屋の定義を足すと部屋が増える", () => {
    const floor = arrangeFloor([...OFFICE_ROOMS, STUDY]);
    expect(floor.rooms).toHaveLength(OFFICE_ROOMS.length + 1);
    const study = floor.rooms.find((r) => r.def.id === "study");
    if (!study) throw new Error("書斎が無い");
    // 奥の列の右の端に並び、フロアと廊下がその分だけ広がる
    expect(study.x).toBe(FLOOR.cols);
    expect(floor.cols).toBe(FLOOR.cols + STUDY.size.w);
    expect(floor.areaAt(floor.cols - 1, floor.hallZ)).toBe(HALL);
    // 足した部屋の家具は塞ぎ、社長の席から出入り口を通って机の前まで歩ける
    expect(floor.isBlocked(study.x + 1, study.z + 1)).toBe(true);
    const goal = { x: study.x + 1.5, z: study.z + 2.5 };
    const tiles = floor.route(SEATS.president.seat, goal).slice(1, -1).map(tileOf);
    expect(tiles.at(-1)).toEqual(tileOf(goal));
    for (let i = 1; i < tiles.length; i++) {
      const a = tiles[i - 1];
      const b = tiles[i];
      if (!a || !b) continue;
      expect(floor.canStep(a, b)).toBe(true);
    }
    // 元のフロアの部屋の置き場は変わらない
    for (const r of FLOOR.rooms) expect(floor.rooms.find((x) => x.def.id === r.def.id)).toMatchObject({ x: r.x, z: r.z });
  });

  it("同じ id の部屋は足せない", () => {
    expect(() => arrangeFloor([...OFFICE_ROOMS, { ...STUDY, id: "work" }])).toThrow(/work/);
  });

  it("幅の外の出入り口は足せない", () => {
    expect(() => arrangeFloor([...OFFICE_ROOMS, { ...STUDY, doors: [3] }])).toThrow(/study.*出入り口/);
    expect(() => arrangeFloor([...OFFICE_ROOMS, { ...STUDY, doors: [-1] }])).toThrow(/study.*出入り口/);
  });

  it("出入り口を家具で塞ぐ部屋は足せない", () => {
    const blocked = { ...STUDY, furniture: [...STUDY.furniture, { kind: "plant" as const, x: 0, z: 2, w: 1, d: 1, blocks: true }] };
    expect(() => arrangeFloor([...OFFICE_ROOMS, blocked])).toThrow(/study.*出入り口/);
  });

  it("部屋からはみ出す家具は置けない", () => {
    const outside = { ...STUDY, furniture: [{ kind: "desk" as const, x: 2, z: 1, w: 2, d: 1, blocks: true }] };
    expect(() => arrangeFloor([...OFFICE_ROOMS, outside])).toThrow(/study.*はみ出す/);
  });

  it("同じ社員の席を 2 つの部屋に置けない", () => {
    const twice = { ...STUDY, seats: { builder: { seat: { x: 1.5, z: 0.6, face: 0 }, handoff: { x: 1.5, z: 2.5, face: Math.PI } } } };
    expect(() => arrangeFloor([...OFFICE_ROOMS, twice])).toThrow(/builder.*席/);
  });
});

describe("社員の居る所", () => {
  it("働く時と止めた時は自分の席、待つ時は休憩所、退勤した時は部屋に居ない", () => {
    expect(stationOf("builder", "working")).toEqual(SEATS.builder.seat);
    expect(stationOf("builder", "stopped")).toEqual(SEATS.builder.seat);
    expect(stationOf("builder", "paused")).toEqual(restSpotOf("builder"));
    expect(stationOf("builder", "off")).toBeNull();
  });

  it("席の無い社員は部屋に居ない", () => {
    expect(stationOf("someone", "working")).toBeNull();
  });
});
