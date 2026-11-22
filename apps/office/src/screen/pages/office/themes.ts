// オフィスの部屋の雰囲気と色の案。使う案は OFFICE_THEME の 1 か所で切り替える (Issue #2 と #3 でオーナーが選ぶ)

/** 部屋の色と明かり。色は CSS の色か、knowidea-tokens の変数 (var(--color-...)) で書く */
export interface OfficeTheme {
  /** 案の名前 */
  label: string;
  /** 部屋の外の背景 */
  background: string;
  /** 床のタイルの 2 色 (市松に並べる) */
  floorA: string;
  floorB: string;
  /** タイルの目地 */
  grout: string;
  /** 廊下の床の 2 色 */
  hallA: string;
  hallB: string;
  /** 敷き詰めの床 (社長室) */
  carpet: string;
  /** 部屋の名前の札と、札の文字 */
  sign: string;
  signText: string;
  /** 奥と左の壁 */
  wall: string;
  /** 手前と右の低い壁と、壁の縁 */
  trim: string;
  /** 奥の壁の窓 */
  window: string;
  /** 作る役と見る役の机の天板 */
  desk: string;
  /** 社長の机 */
  deskPresident: string;
  /** 机の脚、椅子の柱、棚の枠 */
  leg: string;
  /** 椅子の座面と背 */
  chair: string;
  /** パソコンの枠 */
  monitor: string;
  /** 点いている画面 */
  screenOn: string;
  /** 消えている画面 */
  screenOff: string;
  /** 机の明かり */
  lamp: string;
  /** 書類の棚の本体 */
  shelf: string;
  /** 棚に並ぶ書類の背の 3 色 */
  binders: readonly [string, string, string];
  /** ソファ */
  sofa: string;
  /** 休憩所の敷物 */
  rug: string;
  /** 鉢植えの葉 */
  plant: string;
  /** 鉢 */
  pot: string;
  /** 書類 */
  paper: string;
  /** 止めた印 */
  stop: string;
  /** 承認の丸 */
  ok: string;
  /** 差し戻しの印 */
  back: string;
  /** 部屋全体の明るさ (0 から 1) */
  ambient: number;
  /** 窓からの光の強さ */
  sun: number;
  /** 机の明かりが周りを照らす強さ。0 なら照らさない */
  lampGlow: number;
}

/** 案の一覧 */
export const officeThemes = {
  // 案 A (既定): 木の机と明るい床の、昼の小さな事務所。木、ベージュ、白、淡い緑の植物
  wood: {
    label: "木の部屋",
    background: "#f4efe6",
    floorA: "#e8d6bb",
    floorB: "#dfc9a8",
    grout: "#cdb592",
    hallA: "#efe4d2",
    hallB: "#e9dcc6",
    carpet: "#dcc9ab",
    sign: "#fffaf2",
    signText: "#6b4a35",
    wall: "#fbf7f0",
    trim: "#c9a77f",
    window: "#d7ebf2",
    desk: "#c08a57",
    deskPresident: "#9a6a3f",
    leg: "#7a5236",
    chair: "#f2ece2",
    monitor: "#4a4038",
    screenOn: "#eaf6ff",
    screenOff: "#6b625a",
    lamp: "#ffe9b0",
    shelf: "#b98552",
    binders: ["#9cc5a1", "#f0e2c4", "#e6b48c"],
    sofa: "#a9c8a2",
    rug: "#f1e6d0",
    plant: "#8fbf86",
    pot: "#f5f0e8",
    paper: "#ffffff",
    stop: "#d9473b",
    ok: "#3f9a5a",
    back: "#e08a2e",
    ambient: 0.75,
    sun: 2.2,
    lampGlow: 0,
  },
  // 案 B: knowidea-ui の今の色。画面のほかの所と同じ色で、暗い設定にも合わせて変わる
  standard: {
    label: "いつもの色",
    background: "var(--color-bg)",
    floorA: "var(--color-surface-2)",
    floorB: "var(--color-surface)",
    grout: "var(--color-line)",
    hallA: "var(--color-bg)",
    hallB: "var(--color-surface)",
    carpet: "var(--color-surface-2)",
    sign: "var(--color-surface)",
    signText: "var(--color-text)",
    wall: "var(--color-surface)",
    trim: "var(--color-line-strong)",
    window: "var(--color-info-soft)",
    desk: "var(--color-surface)",
    deskPresident: "var(--color-primary)",
    leg: "var(--color-line-strong)",
    chair: "var(--color-text-muted)",
    monitor: "var(--color-text)",
    screenOn: "var(--color-info-soft)",
    screenOff: "var(--color-text-muted)",
    lamp: "var(--color-warn-soft)",
    shelf: "var(--color-line-strong)",
    binders: ["var(--color-primary)", "var(--color-info)", "var(--color-warn)"],
    sofa: "var(--color-primary)",
    rug: "var(--color-line)",
    plant: "var(--color-success)",
    pot: "var(--color-line-strong)",
    paper: "var(--color-surface)",
    stop: "var(--color-error)",
    ok: "var(--color-success)",
    back: "var(--color-warn)",
    ambient: 0.75,
    sun: 1.8,
    lampGlow: 0,
  },
  // 案 C: 夜の事務所。部屋は暗く、働く席の画面と明かりだけが光る
  night: {
    label: "夜の部屋",
    background: "#10162b",
    floorA: "#2a3150",
    floorB: "#242b47",
    grout: "#1b2138",
    hallA: "#202741",
    hallB: "#1c2239",
    carpet: "#2e2a4a",
    sign: "#2a3150",
    signText: "#e6e8f5",
    wall: "#1a2240",
    trim: "#3b4570",
    window: "#3b4f8a",
    desk: "#5a5f7e",
    deskPresident: "#6a4f7a",
    leg: "#2a3150",
    chair: "#5a4a7a",
    monitor: "#0b0e1a",
    screenOn: "#7fd8ff",
    screenOff: "#1c2236",
    lamp: "#ffd27a",
    shelf: "#3f4770",
    binders: ["#6bc4ff", "#c79bff", "#ffd66b"],
    sofa: "#4a5a8a",
    rug: "#2e3a5e",
    plant: "#3f8f6a",
    pot: "#7a5a4a",
    paper: "#f4f4ff",
    stop: "#ff5a4f",
    ok: "#5fd38a",
    back: "#ffb057",
    ambient: 0.35,
    sun: 0.5,
    lampGlow: 2.5,
  },
} as const satisfies Record<string, OfficeTheme>;

/** 案の名前 */
export type OfficeThemeId = keyof typeof officeThemes;

/** 案の名前の並び */
export const THEME_IDS = ["wood", "standard", "night"] as const satisfies readonly OfficeThemeId[];

/** 今使う案。オーナーが選んだら、ここだけを変える */
export const OFFICE_THEME: OfficeThemeId = "wood";

/**
 * 案の名前から色と明かりを返す
 * @param id 案の名前
 * @returns 案の色と明かり
 */
export function themeOf(id: OfficeThemeId): OfficeTheme {
  return officeThemes[id];
}
