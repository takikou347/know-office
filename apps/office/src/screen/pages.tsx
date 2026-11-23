// 8 画面と「その他」と入れた拡張の画面を、道に合わせて選ぶ。中身は screen/pages/<画面>/ に画面ごとに置く
import type { Extension, Health } from "@know-office/core";
import { lazy, Suspense } from "react";
import { DashboardPage } from "./pages/dashboard/DashboardPage.tsx";
import type { Navigate, ToggleExtension } from "./parts/navigate.ts";
import { Section } from "./parts/section.tsx";
import { APPROVALS_PATH, type ExtensionScreenId, type ScreenId, isExtensionScreen } from "./routes.ts";

export type { Navigate, ToggleExtension } from "./parts/navigate.ts";

// 最初に開くダッシュボードだけを入口の JS に入れ、ほかの画面は開いた時に読む。スマートフォンの 4G で 2 秒以内に出すため (画面の全体の 3.4)
const ApprovalsPage = lazy(() => import("./pages/approvals/ApprovalsPage.tsx").then((m) => ({ default: m.ApprovalsPage })));
const GoalsPage = lazy(() => import("./pages/goals/GoalsPage.tsx").then((m) => ({ default: m.GoalsPage })));
const GuardPage = lazy(() => import("./pages/guard/GuardPage.tsx").then((m) => ({ default: m.GuardPage })));
const RecordsPage = lazy(() => import("./pages/ledger/RecordsPage.tsx").then((m) => ({ default: m.RecordsPage })));
const ExtensionPage = lazy(() => import("./pages/more/ExtensionPage.tsx").then((m) => ({ default: m.ExtensionPage })));
const MorePage = lazy(() => import("./pages/more/MorePage.tsx").then((m) => ({ default: m.MorePage })));
const OfficePage = lazy(() => import("./pages/office/OfficePage.tsx").then((m) => ({ default: m.OfficePage })));
const ServicesPage = lazy(() => import("./pages/services/ServicesPage.tsx").then((m) => ({ default: m.ServicesPage })));
const SettingsPage = lazy(() => import("./pages/settings/SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const StaffPage = lazy(() => import("./pages/staff/StaffPage.tsx").then((m) => ({ default: m.StaffPage })));

export interface PageProps {
  screen: ScreenId | ExtensionScreenId | "more";
  pathname: string;
  query: URLSearchParams;
  health?: Health;
  navigate: Navigate;
  /** 入口が返した拡張 */
  extensions: readonly Extension[];
  /** 拡張を入れるか切る */
  toggleExtension: ToggleExtension;
}

export function Page(props: PageProps) {
  return (
    <Suspense fallback={<p role="status">画面を読んでいます</p>}>
      <Chosen {...props} />
    </Suspense>
  );
}

function Chosen({ screen, pathname, query, navigate, extensions, toggleExtension }: PageProps) {
  if (isExtensionScreen(screen)) return <ExtensionPage id={screen.slice("ext:".length)} />;
  switch (screen) {
    case "dashboard":
      // 承認を決める画面は、ダッシュボードの「承認を待つ物」と通知 approval_requested から移る先で、切り替えには出さない。題は headingOf が「承認」にする
      if (pathname === APPROVALS_PATH || pathname.startsWith(`${APPROVALS_PATH}/`)) return <ApprovalsPage pathname={pathname} />;
      return <DashboardPage />;
    case "staff":
      return <StaffPage pathname={pathname} query={query} navigate={navigate} />;
    case "goals":
      return (
        <Section>
          <GoalsPage pathname={pathname} navigate={navigate} />
        </Section>
      );
    case "office":
      return (
        <Section>
          <OfficePage />
        </Section>
      );
    case "services":
      return <ServicesPage pathname={pathname} navigate={navigate} />;
    case "guard":
      return <GuardPage />;
    case "records":
      return <RecordsPage query={query} />;
    case "settings":
      return <SettingsPage extensions={extensions} toggleExtension={toggleExtension} />;
    case "more":
      return <MorePage extensions={extensions} />;
    default:
      return screen satisfies never;
  }
}
