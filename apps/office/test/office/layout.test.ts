import { describe, expect, it } from "vitest";
import { FURNITURE, GRID, SEATS, isBlocked, restSpotOf, routeBetween, stationOf, tileOf } from "../../src/screen/pages/office/layout.ts";

// オフィスの部屋の席と道の配置。画面の全体の 3.2

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

  it("家具は部屋の中にあり、道を塞ぐ家具どうしは重ならない", () => {
    const used = new Set<string>();
    for (const f of FURNITURE) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.z).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(GRID.cols);
      expect(f.z + f.d).toBeLessThanOrEqual(GRID.rows);
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
    expect(path.slice(1, -1).map(tileOf)).toEqual([
      { x: 1, z: 5 },
      { x: 2, z: 5 },
      { x: 3, z: 5 },
    ]);
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
