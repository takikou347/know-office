import type { Health } from "@know-office/core";
import { AppBar, AppShell } from "knowidea-ui";
import { type Navigate, Page } from "./pages.tsx";
import { bottomCurrentOf, bottomItems, morePath, screenOf, sideItems } from "./routes.ts";

export interface AppProps {
  health?: Health;
  /** 今の道と問い。例 /staff/builder?tab=tasks */
  url?: string;
  /** 道を変える。無ければ何もしない (サーバーで描く時) */
  navigate?: Navigate;
}

export function App({ health, url = "/", navigate = () => {} }: AppProps) {
  const { pathname, searchParams } = new URL(url, "http://localhost");
  const more = pathname === morePath;
  const screen = screenOf(pathname);
  return (
    <AppShell
      items={sideItems}
      current={more ? undefined : screen.id}
      bottomItems={bottomItems}
      bottomCurrent={bottomCurrentOf(pathname)}
      brand={{ name: "know-office" }}
      header={<AppBar title={more ? "その他" : screen.label} position="sticky" />}
    >
      <Page
        screen={more ? "more" : screen.id}
        pathname={pathname}
        query={searchParams}
        health={health}
        navigate={navigate}
      />
    </AppShell>
  );
}
