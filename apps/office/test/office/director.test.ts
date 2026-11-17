import { describe, expect, it, vi } from "vitest";
import { type ActorState, GIVE_MS, MARK_MS, WALK_SPEED, createDirector } from "../../src/screen/pages/office/director.ts";

// 動きの列を時刻に合わせて進める。three.js を使わずに、社員の位置、運ぶ物、印を決める。画面の全体の 3.2

/**
 * 席に座っている社員を作る
 * @param id 社員の id
 * @returns 社員の動きの様子
 */
const actor = (id: string): ActorState => ({ id, pos: { x: 0, z: 0 }, face: 0, present: true, carry: false, walking: false, giving: false, mark: null });

/**
 * 社員 1 人と、書類を置いた机を数える関数で、動きの進め役を作る
 * @returns 進め役、社員、置いた机の記録
 */
function setup() {
  const a = actor("president");
  const given = vi.fn<(desk: string) => void>();
  const director = createDirector(new Map([[a.id, a]]), given);
  return { a, given, director };
}

const walkEast = { kind: "walk" as const, actor: "president", path: [{ x: 0, z: 0 }, { x: 1.8, z: 0 }], carry: "paper" as const };

describe("動きを進める", () => {
  it("歩く途中は、道の上の時刻に合う所に居て、書類を運ぶ", () => {
    const { a, director } = setup();
    director.push([walkEast]);
    director.advance(1000);
    director.advance(1500);
    expect(a.pos.x).toBeCloseTo(WALK_SPEED * 0.5);
    expect(a.walking).toBe(true);
    expect(a.carry).toBe(true);
    expect(a.face).toBeCloseTo(Math.PI / 2);
  });

  it("歩き終えると次の段へ進み、置く間は立ち止まってから机に書類を置く", () => {
    const { a, given, director } = setup();
    director.push([walkEast, { kind: "give", actor: "president", desk: "builder" }]);
    director.advance(0);
    director.advance(1000);
    expect(a.walking).toBe(false);
    expect(a.giving).toBe(true);
    expect(given).not.toHaveBeenCalled();
    director.advance(1000 + GIVE_MS);
    expect(given).toHaveBeenCalledWith("builder");
    expect(a.carry).toBe(false);
    expect(a.giving).toBe(false);
    expect(director.busy()).toBe(false);
  });

  it("部屋に居ない者 (オーナー) が渡した書類も机に届く", () => {
    const { given, director } = setup();
    director.push([{ kind: "give", actor: "owner", desk: "builder" }]);
    director.advance(0);
    director.advance(GIVE_MS);
    expect(given).toHaveBeenCalledWith("builder");
    expect(director.busy()).toBe(false);
  });

  it("印は出してから時間が過ぎると消える", () => {
    const { a, director } = setup();
    director.push([{ kind: "mark", actor: "president", mark: "ok" }]);
    director.advance(100);
    expect(a.mark?.kind).toBe("ok");
    director.advance(100 + MARK_MS + 1);
    expect(a.mark).toBeNull();
  });

  it("止めると、残りの段を歩かずに置き換え、書類と印は出す", () => {
    const { a, given, director } = setup();
    const seat = { x: 5, z: 1, face: 0 };
    director.push([walkEast, { kind: "give", actor: "president", desk: "builder" }, { kind: "mark", actor: "president", mark: "back" }, { kind: "place", actor: "president", at: seat }]);
    director.advance(0);
    director.advance(200);
    director.settle();
    expect(given).toHaveBeenCalledWith("builder");
    expect(a.walking).toBe(false);
    expect(a.carry).toBe(false);
    expect(a.pos).toEqual({ x: 5, z: 1 });
    expect(a.mark?.kind).toBe("back");
    expect(director.busy()).toBe(false);
  });

  it("退勤の置き換えで部屋から居なくなる", () => {
    const { a, director } = setup();
    director.push([{ kind: "place", actor: "president", at: null }]);
    director.advance(0);
    expect(a.present).toBe(false);
  });
});
