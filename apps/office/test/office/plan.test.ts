import { describe, expect, it } from "vitest";
import { SEATS, restSpotOf } from "../../src/screen/pages/office/layout.ts";
import { type Actors, type Step, planMotions } from "../../src/screen/pages/office/plan.ts";

// 出来事から、どの社員がどこからどこへ、何を持って動くかを決める。画面の 3.4

const actors: Actors = {
  president: { at: SEATS.president.seat, canMove: true },
  builder: { at: SEATS.builder.seat, canMove: true },
  reviewer: { at: restSpotOf("reviewer"), canMove: true },
};

const walks = (steps: Step[]) => steps.filter((s) => s.kind === "walk");

describe("動きの列", () => {
  it("仕事を渡す: 社長が書類を持って作る役の机まで歩き、渡して戻る", () => {
    const steps = planMotions({ kind: "assign", taskId: "t9", title: "通知を作る", from: "president", to: "builder" }, actors, { reduce: false });
    expect(steps.map((s) => s.kind)).toEqual(["walk", "give", "walk", "place"]);
    const [go, give, back, place] = steps;
    if (go?.kind !== "walk" || give?.kind !== "give" || back?.kind !== "walk" || place?.kind !== "place") throw new Error("形が違う");
    expect(go.actor).toBe("president");
    expect(go.carry).toBe("paper");
    expect(go.path[0]).toEqual({ x: SEATS.president.seat.x, z: SEATS.president.seat.z });
    expect(go.path.at(-1)).toEqual({ x: SEATS.builder.handoff.x, z: SEATS.builder.handoff.z });
    expect(give).toEqual({ kind: "give", actor: "president", desk: "builder" });
    expect(back.carry).toBeNull();
    expect(back.path.at(-1)).toEqual({ x: SEATS.president.seat.x, z: SEATS.president.seat.z });
    expect(place).toEqual({ kind: "place", actor: "president", at: SEATS.president.seat });
  });

  it("レビューを頼む: 作る役が見る役の机へ書類を運ぶ", () => {
    const steps = planMotions({ kind: "review-request", taskId: "t1", title: "A", from: "builder", to: "reviewer" }, actors, { reduce: false });
    const [go] = walks(steps);
    expect(go?.actor).toBe("builder");
    expect(go?.carry).toBe("paper");
    expect(go?.path.at(-1)).toEqual({ x: SEATS.reviewer.handoff.x, z: SEATS.reviewer.handoff.z });
    expect(steps).toContainEqual({ kind: "give", actor: "builder", desk: "reviewer" });
  });

  it("承認は見る役の頭上に丸、差し戻しは戻す印を出す", () => {
    expect(planMotions({ kind: "approve", taskId: "t2", title: "B", by: "reviewer", owner: "builder" }, actors, { reduce: false })).toEqual([
      { kind: "mark", actor: "reviewer", mark: "ok" },
    ]);
    expect(planMotions({ kind: "send-back", taskId: "t2", title: "B", by: "reviewer", to: "builder" }, actors, { reduce: false })).toEqual([
      { kind: "mark", actor: "reviewer", mark: "back" },
    ]);
  });

  it("動きを減らす設定では歩かず、置き換えるだけ", () => {
    const steps = planMotions({ kind: "assign", taskId: "t9", title: "通知を作る", from: "president", to: "builder" }, actors, { reduce: true });
    expect(walks(steps)).toEqual([]);
    expect(steps).toEqual([{ kind: "give", actor: "president", desk: "builder" }]);
    const moved = planMotions({ kind: "state", staffId: "reviewer", from: "paused", to: "working" }, actors, { reduce: true });
    expect(moved).toEqual([{ kind: "place", actor: "reviewer", at: SEATS.reviewer.seat }]);
  });

  it("動けない社員 (止めた、退勤した) は歩かず、書類だけが届く", () => {
    const stuck: Actors = { ...actors, president: { at: SEATS.president.seat, canMove: false } };
    expect(planMotions({ kind: "assign", taskId: "t9", title: "X", from: "president", to: "builder" }, stuck, { reduce: false })).toEqual([
      { kind: "give", actor: "president", desk: "builder" },
    ]);
    const gone: Actors = { ...actors, president: { at: null, canMove: false } };
    expect(walks(planMotions({ kind: "assign", taskId: "t9", title: "X", from: "president", to: "builder" }, gone, { reduce: false }))).toEqual([]);
  });

  it("状態が変わると、前の場所から次の場所へ歩き、退勤すると部屋から居なくなる", () => {
    const steps = planMotions({ kind: "state", staffId: "reviewer", from: "paused", to: "working" }, actors, { reduce: false });
    const [go] = walks(steps);
    expect(go?.path[0]).toEqual({ x: restSpotOf("reviewer").x, z: restSpotOf("reviewer").z });
    expect(go?.path.at(-1)).toEqual({ x: SEATS.reviewer.seat.x, z: SEATS.reviewer.seat.z });
    expect(go?.carry).toBeNull();
    expect(steps.at(-1)).toEqual({ kind: "place", actor: "reviewer", at: SEATS.reviewer.seat });
    expect(planMotions({ kind: "state", staffId: "builder", from: "working", to: "off" }, actors, { reduce: false })).toEqual([
      { kind: "place", actor: "builder", at: null },
    ]);
  });
});
