import type { Extension, Health } from "@know-office/core";
import { AppBar, AppShell } from "knowidea-ui";
import { withScreens } from "./extensions.ts";
import { type Navigate, Page, type ToggleExtension } from "./pages.tsx";
import { LiveNoticeBar, NoticeHold, NoticeProvider } from "./parts/notices.tsx";
import { bottomCurrentOf, bottomItems, morePath, screenOf, sideItemsWith } from "./routes.ts";

export interface AppProps {
  health?: Health;
  /** 今の道と問い。例 /staff/builder?tab=tasks */
  url?: string;
  /** 道を変える。無ければ何もしない (サーバーで描く時) */
  navigate?: Navigate;
  /** 入口が返した拡張。入れた拡張の画面を 8 の画面の後ろに並べる */
  extensions?: readonly Extension[];
  /** 拡張を入れるか切る。無ければ何もしない (サーバーで描く時) */
  toggleExtension?: ToggleExtension;
}

export function App({ health, url = "/", navigate = () => {}, extensions = [], toggleExtension = () => Promise.resolve() }: AppProps) {
  const { pathname, searchParams } = new URL(url, "http://localhost");
  const more = pathname === morePath;
  const shown = withScreens(extensions);
  const screen = screenOf(pathname, shown);
  return (
    <NoticeProvider>
      <NoticeHold>
        <AppShell
          items={sideItemsWith(shown)}
          current={more ? undefined : screen.id}
          bottomItems={bottomItems}
          bottomCurrent={bottomCurrentOf(pathname, shown)}
          brand={{ name: "know-office" }}
          header={
            <>
              <AppBar title={more ? "その他" : screen.label} position="sticky" />
              <LiveNoticeBar />
            </>
          }
        >
          <Page
            screen={more ? "more" : screen.id}
            pathname={pathname}
            query={searchParams}
            health={health}
            navigate={navigate}
            extensions={extensions}
            toggleExtension={toggleExtension}
          />
        </AppShell>
      </NoticeHold>
    </NoticeProvider>
  );
}
