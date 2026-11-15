// 社員の状態 (働く、待つ、止まる、退勤) ごとの、ある時刻の形。three.js を使わずに決め、部屋はこの形を姿に当てる
import type { Staff } from "../../mock.ts";

/** ある時刻の社員の形 */
export interface Pose {
  /** 部屋に姿を出すか。退勤した社員は出さない */
  visible: boolean;
  /** 椅子に座っているか */
  seated: boolean;
  /** 腕の振り (ラジアン)。左右で逆に当てる */
  arm: number;
  /** 体の上下 (部屋の単位) */
  lift: number;
  /** 首の左右の向き (ラジアン) */
  head: number;
  /** 机の明かりと画面を点けるか */
  lamp: boolean;
  /** 頭の上の印 */
  mark: "stop" | null;
  /** 体の色を薄くするか */
  dim: boolean;
}

const TAU = Math.PI * 2;

/**
 * 社員の状態と時刻から形を決める
 * @param state 社員の状態
 * @param t 動き始めからの時刻 (ミリ秒)
 * @returns その時刻の形
 */
export function poseOf(state: Staff["state"], t: number): Pose {
  switch (state) {
    case "working":
      // キーを打つ速さで腕を振り、少し体を揺らす
      return {
        visible: true,
        seated: true,
        arm: 0.35 * Math.sin((TAU * 3 * t) / 1000),
        lift: 0.01 * Math.abs(Math.sin((TAU * 3 * t) / 1000)),
        head: 0.08 * Math.sin((TAU * t) / 2400),
        lamp: true,
        mark: null,
        dim: false,
      };
    case "paused":
      // 手を止め、4 秒で 1 回息をし、ゆっくり周りを見る
      return {
        visible: true,
        seated: true,
        arm: 0,
        lift: 0.02 * Math.sin((TAU * t) / 4000),
        head: 0.5 * Math.sin((TAU * t) / 7000),
        lamp: true,
        mark: null,
        dim: false,
      };
    case "stopped":
      return { visible: true, seated: true, arm: 0, lift: 0, head: 0, lamp: false, mark: "stop", dim: true };
    case "off":
      return { visible: false, seated: false, arm: 0, lift: 0, head: 0, lamp: false, mark: null, dim: false };
    default:
      return state satisfies never;
  }
}
