// 子犬の社員の、することごとの、ある時刻の形。three.js を使わずに決め、部屋はこの形を姿に当てる
import type { Staff } from "../../mock.ts";

/** 子犬のすること。状態から決まる 4 つに、出来事で歩く時を足す */
export type Activity = "work" | "wait" | "stopped" | "off" | "walk";

/** ある時刻の子犬の形 */
export interface Pose {
  /** 部屋に姿を出すか */
  visible: boolean;
  /** 座るか立つか */
  posture: "sit" | "stand";
  /** 前足を打つ振り (ラジアン)。左右で逆に当てる */
  paws: number;
  /** 歩く足の振り (ラジアン)。対角の足をそろえる */
  legs: number;
  /** 耳の揺れ (ラジアン) */
  ears: number;
  /** しっぽの振り (ラジアン) */
  tail: number;
  /** 目を閉じているか */
  blink: boolean;
  /** 体の上下 (タイルの単位) */
  lift: number;
  /** 首の左右の向き (ラジアン) */
  head: number;
  /** 顔つき */
  face: "normal" | "trouble";
  /** 頭の上の印 */
  mark: "stop" | null;
}

const TAU = Math.PI * 2;
const wave = (t: number, period: number, phase = 0) => Math.sin((TAU * t) / period + phase);

// 3.7 秒に 1 回、0.15 秒だけ目を閉じる
const blinkAt = (t: number) => t % 3700 < 150;

/**
 * 社員の状態から、することを決める
 * @param state 社員の状態
 * @returns すること
 */
export function activityOf(state: Staff["state"]): Activity {
  const map = { working: "work", paused: "wait", stopped: "stopped", off: "off" } as const;
  return map[state];
}

const still: Pose = {
  visible: true,
  posture: "sit",
  paws: 0,
  legs: 0,
  ears: 0,
  tail: 0,
  blink: false,
  lift: 0,
  head: 0,
  face: "normal",
  mark: null,
};

/**
 * することと時刻から形を決める
 * @param activity すること
 * @param t 動き始めからの時刻 (ミリ秒)
 * @returns その時刻の形
 */
export function poseOf(activity: Activity, t: number): Pose {
  switch (activity) {
    case "work":
      // 机でキーを打つ速さで前足を振り、しっぽはゆっくり揺らす
      return {
        ...still,
        paws: 0.3 * wave(t, 333),
        lift: 0.008 * Math.abs(wave(t, 333)),
        head: 0.06 * wave(t, 2600),
        tail: 0.15 * wave(t, 1800),
        blink: blinkAt(t),
      };
    case "wait": {
      // おすわりで 3.5 秒に 1 回息をし、5 秒ごとに 1.2 秒しっぽを振る
      const wagging = t % 5000 < 1200;
      return {
        ...still,
        lift: 0.015 * wave(t, 3500),
        head: 0.35 * wave(t, 7000),
        tail: wagging ? 0.6 * wave(t, 250) : 0.08 * wave(t, 2000),
        blink: blinkAt(t),
      };
    }
    case "walk":
      return {
        ...still,
        posture: "stand",
        legs: 0.6 * wave(t, 400),
        ears: 0.2 * wave(t, 400, 1),
        tail: 0.5 * wave(t, 300),
        lift: 0.03 * Math.abs(wave(t, 400)),
        blink: blinkAt(t),
      };
    case "stopped":
      return { ...still, ears: -0.2, head: 0, face: "trouble", mark: "stop" };
    case "off":
      return { ...still, visible: false };
    default:
      return activity satisfies never;
  }
}
