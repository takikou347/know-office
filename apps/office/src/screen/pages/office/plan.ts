// 出来事から、どの社員がどこからどこへ、何を持って動くかの列を決める
import type { OfficeEvent } from "./events.ts";
import { type Point, type Spot, routeBetween, seatOf, stationOf } from "./layout.ts";

/** 社員の今の居る所と、歩けるか */
export type Actors = Readonly<Record<string, { at: Spot | null; canMove: boolean }>>;

/** 動きの 1 段 */
export type Step =
  /** 道に沿って歩く。carry は口にくわえて運ぶ物 */
  | { kind: "walk"; actor: string; path: Point[]; carry: "paper" | null }
  /** 書類をその社員の机に置く */
  | { kind: "give"; actor: string; desk: string }
  /** 頭の上に丸か戻す印を出す */
  | { kind: "mark"; actor: string; mark: "ok" | "back" }
  /** その所に置く。null なら部屋から居なくなる */
  | { kind: "place"; actor: string; at: Spot | null };

/**
 * 書類を相手の机へ運ぶ列を作る。歩けない時と動きを減らす設定の時は、書類だけが届く
 * @param actor 運ぶ社員
 * @param desk 机の持ち主
 * @param actors 社員の居る所
 * @param reduce 動きを減らす設定か
 * @returns 動きの列
 */
function carryTo(actor: string, desk: string, actors: Actors, reduce: boolean): Step[] {
  const me = actors[actor];
  const target = seatOf(desk)?.handoff ?? null;
  const give: Step = { kind: "give", actor, desk };
  if (reduce || !me?.at || !me.canMove || !target) return [give];
  return [
    { kind: "walk", actor, path: routeBetween(me.at, target), carry: "paper" },
    give,
    { kind: "walk", actor, path: routeBetween(target, me.at), carry: null },
    { kind: "place", actor, at: me.at },
  ];
}

/**
 * 出来事から動きの列を決める
 * @param e 出来事
 * @param actors 社員の今の居る所と、歩けるか
 * @param opts 動きの決まり
 * @param opts.reduce 動きを減らす設定か。歩かずに置き換える
 * @returns 動きの列
 */
export function planMotions(e: OfficeEvent, actors: Actors, opts: { reduce: boolean }): Step[] {
  switch (e.kind) {
    case "assign":
    case "review-request":
      return carryTo(e.from, e.to, actors, opts.reduce);
    case "approve":
      return [{ kind: "mark", actor: e.by, mark: "ok" }];
    case "send-back":
      return [{ kind: "mark", actor: e.by, mark: "back" }];
    case "state": {
      const from = actors[e.staffId]?.at ?? null;
      const to = stationOf(e.staffId, e.to);
      const place: Step = { kind: "place", actor: e.staffId, at: to };
      // 止めた社員は歩けない。止められた時は、その場から席へ置き換える
      if (opts.reduce || !from || !to || e.from === "stopped" || e.to === "stopped") return [place];
      return [{ kind: "walk", actor: e.staffId, path: routeBetween(from, to), carry: null }, place];
    }
    default:
      return e satisfies never;
  }
}
