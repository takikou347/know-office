// オフィスの部屋の雰囲気と色の案。使う案は OFFICE_THEME の 1 か所で切り替える (Issue #2 と #3 でオーナーが選ぶ)

/** 部屋の色と明かり。色は CSS の色か、knowidea-tokens の変数 (var(--color-...)) で書く */
export interface OfficeTheme {
  /** 案の名前 */
  label: string;
  /** 部屋の背景 */
  background: string;
  /** 床 */
  floor: string;
  /** 机の並ぶ所に敷く敷物 */
  rug: string;
  /** 奥と左の壁 */
  wall: string;
  /** 奥の壁の窓 */
  window: string;
  /** 机の天板 */
  desk: string;
  /** 机の脚と椅子の柱 */
  leg: string;
  /** 椅子の座面と背 */
  chair: string;
  /** 画面の枠 */
  monitor: string;
  /** 点いている画面 */
  screenOn: string;
  /** 消えている画面 */
  screenOff: string;
  /** 机の明かり */
  lamp: string;
  /** 鉢植えの葉 */
  plant: string;
  /** 鉢 */
  pot: string;
  /** 社員の顔と手 */
  face: string;
  /** 社員の目 */
  eye: string;
  /** 止めた印 */
  stop: string;
  /** 社員の体の色。席の順に使い、足りなければ繰り返す */
  staff: readonly string[];
  /** 部屋全体の明るさ (0 から 1) */
  ambient: number;
  /** 窓からの光の強さ */
  sun: number;
  /** 机の明かりが周りを照らす強さ。0 なら照らさない */
  lampGlow: number;
}

/** 案の一覧 */
export const officeThemes = {
  // 案 A: knowidea-ui の今の色。画面のほかの所と同じ色で、暗い設定にも合わせて変わる
  standard: {
    label: "いつもの色",
    background: "var(--color-bg)",
    floor: "var(--color-surface-2)",
    rug: "var(--color-line)",
    wall: "var(--color-surface)",
    window: "var(--color-info-soft)",
    desk: "var(--color-surface)",
    leg: "var(--color-line-strong)",
    chair: "var(--color-text-muted)",
    monitor: "var(--color-text)",
    screenOn: "var(--color-info-soft)",
    screenOff: "var(--color-text-muted)",
    lamp: "var(--color-warn-soft)",
    plant: "var(--color-success)",
    pot: "var(--color-line-strong)",
    face: "var(--color-surface)",
    eye: "var(--color-text)",
    stop: "var(--color-error)",
    staff: ["var(--color-primary)", "var(--color-success)", "var(--color-info)", "var(--color-warn)"],
    ambient: 0.75,
    sun: 1.6,
    lampGlow: 0,
  },
  // 案 B: 木の机と明るい床の、昼の小さな事務所
  wood: {
    label: "木の部屋",
    background: "#f3ece2",
    floor: "#d9c3a5",
    rug: "#b9cbb5",
    wall: "#f7f1e8",
    window: "#cfe6f2",
    desk: "#b07a4a",
    leg: "#6e4a2c",
    chair: "#3f6d5c",
    monitor: "#2b2b2b",
    screenOn: "#e8f4ff",
    screenOff: "#56514b",
    lamp: "#ffe6a8",
    plant: "#4f8a3c",
    pot: "#c46f4b",
    face: "#f6dcc4",
    eye: "#2a2a2a",
    stop: "#c8382c",
    staff: ["#e0874a", "#4f86c6", "#9b6bbf", "#d4b13a"],
    ambient: 0.7,
    sun: 2,
    lampGlow: 0,
  },
  // 案 C: 夜の事務所。部屋は暗く、働く席の画面と明かりだけが光る
  night: {
    label: "夜の部屋",
    background: "#10162b",
    floor: "#222a45",
    rug: "#2e3a5e",
    wall: "#1a2240",
    window: "#3b4f8a",
    desk: "#46506e",
    leg: "#2a3150",
    chair: "#5a4a7a",
    monitor: "#0b0e1a",
    screenOn: "#7fd8ff",
    screenOff: "#1c2236",
    lamp: "#ffd27a",
    plant: "#3f8f6a",
    pot: "#7a5a4a",
    face: "#f0d8c8",
    eye: "#10162b",
    stop: "#ff5a4f",
    staff: ["#ff9f6b", "#6bc4ff", "#c79bff", "#ffd66b"],
    ambient: 0.35,
    sun: 0.5,
    lampGlow: 2.5,
  },
} as const satisfies Record<string, OfficeTheme>;

/** 案の名前 */
export type OfficeThemeId = keyof typeof officeThemes;

/** 案の名前の並び */
export const THEME_IDS = ["standard", "wood", "night"] as const satisfies readonly OfficeThemeId[];

/** 今使う案。オーナーが選んだら、ここだけを変える */
export const OFFICE_THEME: OfficeThemeId = "standard";

/**
 * 案の名前から色と明かりを返す
 * @param id 案の名前
 * @returns 案の色と明かり
 */
export function themeOf(id: OfficeThemeId): OfficeTheme {
  return officeThemes[id];
}
