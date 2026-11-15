// 社員の姿の元。モデルを指した社員はそれ (glTF か VRM) を読み、指していない社員は形を組み合わせた人形にする
import type { Object3D } from "three";
import type { Pose } from "./motion.ts";

/**
 * 社員の id からモデルの URL。モデルを差し替える時は public/models/staff/<社員>.glb (か .vrm) を置き、ここに 1 行足す
 * 例: `builder: "/models/staff/builder.glb"`
 */
export const STAFF_MODELS: Readonly<Record<string, string>> = {};

/** 社員の姿の元 */
export type AvatarSource = { kind: "shapes" } | { kind: "vrm"; url: string } | { kind: "gltf"; url: string };

/** 読み込んだモデルの姿。glTF と VRM で同じ形にする */
export interface ModelAvatar {
  /** 部屋に置く物 */
  object: Object3D;
  /** 形を当てる */
  applyPose: (pose: Pose) => void;
  /** 時間で動く所を進める */
  update: (seconds: number) => void;
  /** 使った物を捨てる */
  dispose: () => void;
}

/**
 * 社員の姿の元を決める。URL の拡張子 (大文字小文字を問わず、? と # の後ろは見ない) で読み方を分ける
 * @param staffId 社員の id
 * @param models 社員の id からモデルの URL
 * @returns 姿の元
 */
export function avatarSourceOf(staffId: string, models: Readonly<Record<string, string>> = STAFF_MODELS): AvatarSource {
  const url = models[staffId];
  if (!url) return { kind: "shapes" };
  const path = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".vrm")) return { kind: "vrm", url };
  if (path.endsWith(".glb") || path.endsWith(".gltf")) return { kind: "gltf", url };
  return { kind: "shapes" };
}
