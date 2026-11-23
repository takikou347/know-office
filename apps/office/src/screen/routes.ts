// 画面の一覧と道。左の切り替えには 8 つすべてと入れた拡張の画面、下には主な 4 つと「その他」を出す
import type { NavItem } from "knowidea-ui";

export type ScreenId =
  | "dashboard"
  | "staff"
  | "goals"
  | "office"
  | "services"
  | "guard"
  | "records"
  | "settings";

/** 拡張の画面の id。`ext:<拡張 ID>` */
export type ExtensionScreenId = `ext:${string}`;

export interface Screen {
  id: ScreenId | ExtensionScreenId;
  path: string;
  label: string;
  icon: NonNullable<NavItem["icon"]>;
}

const dashboardScreen: Screen = { id: "dashboard", path: "/", label: "ホーム", icon: "home" };

export const screens: readonly Screen[] = [
  dashboardScreen,
  { id: "staff", path: "/staff", label: "社員", icon: "users" },
  { id: "goals", path: "/goals", label: "目標", icon: "flag" },
  { id: "office", path: "/office", label: "オフィス", icon: "buildings" },
  { id: "services", path: "/services", label: "アイデアとサービス", icon: "lightbulb" },
  { id: "guard", path: "/guard", label: "ハーネス", icon: "stop" },
  { id: "records", path: "/records", label: "記録", icon: "chart-bar" },
  { id: "settings", path: "/settings", label: "設定", icon: "settings" },
];

const bottomIds: readonly ScreenId[] = ["dashboard", "staff", "services", "guard"];

export const morePath = "/more";

const navOf = (s: Screen): NavItem => ({ id: s.id, label: s.label, icon: s.icon, href: s.path });

export const sideItems: NavItem[] = screens.map(navOf);

export const bottomItems: NavItem[] = [
  ...screens.filter((s) => bottomIds.some((id) => id === s.id)).map(navOf),
  { id: "more", label: "その他", icon: "more", href: morePath },
];

export const moreScreens: readonly Screen[] = screens.filter((s) => !bottomIds.some((id) => id === s.id));


/**
 * 画面の id が拡張の画面の物かを見る
 * @param id 画面の id
 * @returns `ext:` で始まれば true
 */
export function isExtensionScreen(id: string): id is ExtensionScreenId {
  return id.startsWith("ext:");
}

/** 切り替えに並べる拡張。入れていない物は並べない */
export interface ExtensionNav {
  /** 拡張 ID */
  id: string;
  /** 画面の名前 */
  title: string;
  /** 入れているか */
  enabled: boolean;
  /** 切り替えの絵。無ければメモの絵 */
  icon?: NonNullable<NavItem["icon"]>;
}

/**
 * 拡張の画面の道を作る
 * @param id 拡張 ID
 * @returns `/ext/<拡張 ID>`
 */
export function extensionPath(id: string): string {
  return `/ext/${id}`;
}

/**
 * 入れた拡張を、8 の画面の後ろに並べる画面にする
 * @param extensions 拡張
 * @returns 入れた拡張の画面
 */
function extensionScreens(extensions: readonly ExtensionNav[]): Screen[] {
  return extensions.filter((e) => e.enabled).map((e) => ({ id: `ext:${e.id}`, path: extensionPath(e.id), label: e.title, icon: e.icon ?? "note" }));
}

/**
 * 左の切り替えを、8 の画面の後ろに入れた拡張の画面を足して作る
 * @param extensions 拡張
 * @returns 左の切り替えの項目
 */
export function sideItemsWith(extensions: readonly ExtensionNav[]): NavItem[] {
  return [...sideItems, ...extensionScreens(extensions).map(navOf)];
}

/**
 * その他の画面を、入れた拡張の画面を足して作る
 * @param extensions 拡張
 * @returns その他に並べる画面
 */
export function moreScreensWith(extensions: readonly ExtensionNav[]): Screen[] {
  return [...moreScreens, ...extensionScreens(extensions)];
}

/**
 * パスの頭から画面を決める。知らないパスと、入れていない拡張の道はダッシュボードにする
 * @param pathname URL のパス
 * @param extensions 拡張
 * @returns 開く画面
 */
export function screenOf(pathname: string, extensions: readonly ExtensionNav[] = []): Screen {
  const [, head = "", id = ""] = pathname.split("/");
  if (head === "ext") return extensionScreens(extensions).find((s) => s.path === extensionPath(id)) ?? dashboardScreen;
  return screens.find((s) => s.path === `/${head}`) ?? dashboardScreen;
}

/**
 * 下の切り替えで印を付ける id を決める。下に無い画面と「その他」は more にする
 * @param pathname URL のパス
 * @param extensions 拡張
 * @returns 印を付ける id
 */
export function bottomCurrentOf(pathname: string, extensions: readonly ExtensionNav[] = []): string {
  if (pathname === morePath) return "more";
  const s = screenOf(pathname, extensions);
  return bottomIds.some((id) => id === s.id) ? s.id : "more";
}

/**
 * ブラウザの題を作る
 * @param pathname URL のパス
 * @param extensions 拡張
 * @returns 「画面の名前 - know-office」の題
 */
export function titleOf(pathname: string, extensions: readonly ExtensionNav[] = []): string {
  return `${headingOf(pathname, extensions)} - know-office`;
}

/** 承認を決める画面の道。切り替えには出さず、ダッシュボードから移る */
export const APPROVALS_PATH = "/approvals";

/**
 * 上の帯とブラウザの題に出す名前を決める。承認を決める画面は切り替えの印をダッシュボードに残し、題だけを「承認」にする
 * @param pathname URL のパス
 * @param extensions 拡張
 * @returns 題
 */
export function headingOf(pathname: string, extensions: readonly ExtensionNav[] = []): string {
  if (pathname === morePath) return "その他";
  if (pathname === APPROVALS_PATH || pathname.startsWith(`${APPROVALS_PATH}/`)) return "承認";
  return screenOf(pathname, extensions).label;
}
