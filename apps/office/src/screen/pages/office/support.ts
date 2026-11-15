// オフィスの部屋を 3D で出せるかと、動きを減らす設定かを決める。3D を出せない時は 2D の一覧に代え、動きを減らす設定では歩かずに置き換える

/** 確かめに使うブラウザの口。テストでは作り物を渡す */
export interface Show3dEnv {
  /** 確かめのための canvas を作る */
  createCanvas: () => { getContext: (kind: string) => unknown };
}

/** 動きを減らす設定のメディアクエリ */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 3D の部屋を出せるかを決める。WebGL 2 が使える時だけ出す
 * @param env 確かめに使うブラウザの口
 * @returns 出せる時は true
 */
export function canShow3d(env: Show3dEnv): boolean {
  try {
    return Boolean(env.createCanvas().getContext("webgl2"));
  } catch {
    // 確かめられない時は 2D に倒す
    return false;
  }
}

/**
 * 今のブラウザの口を返す
 * @returns document を使う口
 */
export function browserEnv(): Show3dEnv {
  return { createCanvas: () => document.createElement("canvas") };
}
