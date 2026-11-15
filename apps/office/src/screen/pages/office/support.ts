// オフィスの部屋を 3D で出せるかを決める。出せない時と動きを減らす設定の時は 2D の一覧に代える

/** 確かめに使うブラウザの口。テストでは作り物を渡す */
export interface Show3dEnv {
  /** メディアクエリが合うかを返す */
  matchMedia: (query: string) => { matches: boolean };
  /** 確かめのための canvas を作る */
  createCanvas: () => { getContext: (kind: string) => unknown };
}

/** 動きを減らす設定のメディアクエリ */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 3D の部屋を出せるかを決める。WebGL 2 が使え、動きを減らす設定でない時だけ出す
 * @param env 確かめに使うブラウザの口
 * @returns 出せる時は true
 */
export function canShow3d(env: Show3dEnv): boolean {
  try {
    if (env.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
    return Boolean(env.createCanvas().getContext("webgl2"));
  } catch {
    // 確かめられない時は 2D に倒す
    return false;
  }
}

/**
 * 今のブラウザの口を返す
 * @returns window と document を使う口
 */
export function browserEnv(): Show3dEnv {
  return {
    matchMedia: (q) => window.matchMedia(q),
    createCanvas: () => document.createElement("canvas"),
  };
}
