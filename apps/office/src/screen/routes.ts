// 画面の一覧と道。左の切り替えには 8 つすべて、下には主な 4 つと「その他」を出す
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

export interface Screen {
  id: ScreenId;
  path: string;
  label: string;
  icon: NonNullable<NavItem["icon"]>;
}

const dashboardScreen: Screen = { id: "dashboard", path: "/", label: "ダッシュボード", icon: "home" };

export const screens: readonly Screen[] = [
  dashboardScreen,
  { id: "staff", path: "/staff", label: "社員と仕事", icon: "users" },
  { id: "goals", path: "/goals", label: "目的と組織図", icon: "flag" },
  { id: "office", path: "/office", label: "オフィス", icon: "buildings" },
  { id: "services", path: "/services", label: "アイデアとサービス", icon: "lightbulb" },
  { id: "guard", path: "/guard", label: "守り", icon: "stop" },
  { id: "records", path: "/records", label: "記録", icon: "chart-bar" },
  { id: "settings", path: "/settings", label: "設定", icon: "settings" },
];

const bottomIds: readonly ScreenId[] = ["dashboard", "staff", "services", "guard"];

export const morePath = "/more";

const navOf = (s: Screen): NavItem => ({ id: s.id, label: s.label, icon: s.icon, href: s.path });

export const sideItems: NavItem[] = screens.map(navOf);

export const bottomItems: NavItem[] = [
  ...screens.filter((s) => bottomIds.includes(s.id)).map(navOf),
  { id: "more", label: "その他", icon: "more", href: morePath },
];

export const moreScreens: readonly Screen[] = screens.filter((s) => !bottomIds.includes(s.id));


/** 道の頭から画面を決める。知らない道はダッシュボード */
export function screenOf(pathname: string): Screen {
  const head = `/${pathname.split("/")[1] ?? ""}`;
  return screens.find((s) => s.path === head) ?? dashboardScreen;
}

/** 下の切り替えで印を付ける id。下に無い画面と「その他」は more */
export function bottomCurrentOf(pathname: string): string {
  if (pathname === morePath) return "more";
  const s = screenOf(pathname);
  return bottomIds.includes(s.id) ? s.id : "more";
}

/** ブラウザの題 */
export function titleOf(pathname: string): string {
  const label = pathname === morePath ? "その他" : screenOf(pathname).label;
  return `${label} - know-office`;
}
