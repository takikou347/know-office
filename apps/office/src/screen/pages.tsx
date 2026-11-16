// 8 画面と「その他」と入れた拡張の画面を、道に合わせて選ぶ。中身は screen/pages/<画面>/ に画面ごとに置く
import type { Extension, Health } from "@know-office/core";
import { ApprovalsPage } from "./pages/approvals/ApprovalsPage.tsx";
import { DashboardPage } from "./pages/dashboard/DashboardPage.tsx";
import { GoalsPage } from "./pages/goals/GoalsPage.tsx";
import { GuardPage } from "./pages/guard/GuardPage.tsx";
import { RecordsPage } from "./pages/ledger/RecordsPage.tsx";
import { ExtensionPage } from "./pages/more/ExtensionPage.tsx";
import { MorePage } from "./pages/more/MorePage.tsx";
import { OfficePage } from "./pages/office/OfficePage.tsx";
import { ServicesPage } from "./pages/services/ServicesPage.tsx";
import { SettingsPage } from "./pages/settings/SettingsPage.tsx";
import { StaffPage } from "./pages/staff/StaffPage.tsx";
import type { Navigate, ToggleExtension } from "./parts/navigate.ts";
import { Section } from "./parts/section.tsx";
import { APPROVALS_PATH, type ExtensionScreenId, type ScreenId, isExtensionScreen } from "./routes.ts";

export type { Navigate, ToggleExtension } from "./parts/navigate.ts";

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

export function Page({ screen, pathname, query, health, navigate, extensions, toggleExtension }: PageProps) {
  if (isExtensionScreen(screen)) return <ExtensionPage id={screen.slice("ext:".length)} />;
  switch (screen) {
    case "dashboard":
      // 承認を決める画面は、ダッシュボードの「承認を待つ物」と通知 approval_requested から移る先で、切り替えには出さない。題は headingOf が「承認」にする
      if (pathname === APPROVALS_PATH || pathname.startsWith(`${APPROVALS_PATH}/`)) return <ApprovalsPage pathname={pathname} />;
      return <DashboardPage health={health} />;
    case "staff":
      return <StaffPage pathname={pathname} query={query} navigate={navigate} />;
    case "goals":
      return (
        <Section>
          <GoalsPage />
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
