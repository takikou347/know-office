// 動きの列を時刻に合わせて進める。three.js を使わずに、社員の位置、向き、運ぶ物、頭上の印を決める
import type { Point } from "./layout.ts";
import type { Step } from "./plan.ts";

/** 歩く速さ (タイル毎秒) */
export const WALK_SPEED = 1.8;
/** 書類を机に置くのに掛ける時間 (ミリ秒) */
export const GIVE_MS = 700;
/** 頭上の印を出す時間 (ミリ秒) */
export const MARK_MS = 2400;

/** 社員の動きの様子 */
export interface ActorState {
  id: string;
  pos: Point;
  /** 向き (y 軸の回りのラジアン)。0 で手前を向く */
  face: number;
  /** 部屋に居るか */
  present: boolean;
  /** 書類をくわえているか */
  carry: boolean;
  /** 歩いているか */
  walking: boolean;
  /** 書類を置くために立ち止まっているか */
  giving: boolean;
  /** 頭上の印と、消す時刻。止めている間は消さない */
  mark: { kind: "ok" | "back"; until: number } | null;
}

/** 動きの進め役 */
export interface Director {
  /** 動きの列を後ろに積む */
  push: (steps: readonly Step[]) => void;
  /** 時刻まで動きを進める */
  advance: (t: number) => void;
  /** 残りの列を歩かずに置き換える。動きを止めた時と、動きを減らす設定の時に使う */
  settle: () => void;
  /** 進めている列があるか */
  busy: () => boolean;
}

/**
 * 道の長さに沿って、進んだ道のりの所を返す
 * @param path 通る点
 * @param distance 進んだ道のり
 * @returns 居る所と向き。道を歩き終えていれば null
 */
function along(path: readonly Point[], distance: number): { pos: Point; face: number } | null {
  let left = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) break;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const within = left < length;
    if (within && length > 0) {
      const k = left / length;
      return { pos: { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }, face: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    left -= length;
  }
  return null;
}

/**
 * 動きの進め役を作る
 * @param actors 社員の id ごとの動きの様子。進め役が書き換える
 * @param onGive 書類を机に置いた時に呼ぶ
 * @returns 進め役
 */
export function createDirector(actors: ReadonlyMap<string, ActorState>, onGive: (desk: string) => void): Director {
  const queue: Step[] = [];
  let current: { step: Step; start: number } | null = null;

  // 段を終えた時の変わりを当てる
  const finish = (step: Step, now: number) => {
    const a = actors.get(step.actor);
    // 部屋に居ない者 (オーナー) が渡した書類も机に届ける
    if (step.kind === "give" && !a) onGive(step.desk);
    if (!a) return;
    switch (step.kind) {
      case "walk": {
        const end = step.path.at(-1);
        if (end) a.pos = { ...end };
        a.walking = false;
        return;
      }
      case "give":
        a.carry = false;
        a.giving = false;
        onGive(step.desk);
        return;
      case "mark":
        a.mark = { kind: step.mark, until: now + MARK_MS };
        return;
      case "place":
        a.present = step.at !== null;
        if (step.at) {
          a.pos = { x: step.at.x, z: step.at.z };
          a.face = step.at.face;
        }
        return;
      default:
        step satisfies never;
    }
  };

  // 段を始めた時の変わりを当てる
  const begin = (step: Step) => {
    const a = actors.get(step.actor);
    if (step.kind === "walk" && a) Object.assign(a, { walking: true, carry: step.carry === "paper", present: true });
    if (step.kind === "give" && a) Object.assign(a, { giving: true, face: Math.PI });
  };

  return {
    push: (steps) => {
      // 止めている間に出したままの印は、次の出来事で消す
      for (const a of actors.values()) if (a.mark?.until === Infinity) a.mark = null;
      queue.push(...steps);
    },
    advance: (t) => {
      for (const a of actors.values()) if (a.mark && t > a.mark.until) a.mark = null;
      for (;;) {
        if (current === null) {
          const next = queue.shift();
          if (!next) return;
          current = { step: next, start: t };
          begin(next);
        }
        const { step, start } = current;
        const a = actors.get(step.actor);
        if (step.kind === "walk" && a) {
          const at = along(step.path, ((t - start) / 1000) * WALK_SPEED);
          if (at) {
            a.pos = at.pos;
            a.face = at.face;
            return;
          }
        }
        const stillGiving = step.kind === "give" && t - start < GIVE_MS;
        if (stillGiving) return;
        finish(step, t);
        current = null;
      }
    },
    settle: () => {
      const rest = current ? [current.step, ...queue] : [...queue];
      current = null;
      queue.length = 0;
      for (const step of rest) {
        begin(step);
        finish(step, Infinity);
      }
      for (const a of actors.values()) Object.assign(a, { walking: false, carry: false, giving: false });
    },
    busy: () => current !== null || queue.length > 0,
  };
}
