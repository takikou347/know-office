import "knowidea-tokens/tokens.css";
import "knowidea-css/index.css";
import "./app.css";
import type { Extension, Health } from "@know-office/core";
import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ApiContext, createApi, sessionFetch } from "./api.ts";
import { ExtensionFetchContext, withScreens } from "./extensions.ts";
import { routeOfClick } from "./link.ts";
import { titleOf } from "./routes.ts";

const api = createApi(window.location.origin);

/** 拡張の画面が自分のルートを呼ぶ口。ログインセッションの作り直しは入口の RPC と同じ */
const extensionOrigin = { base: window.location.origin, fetch: sessionFetch(window.location.origin) };

/** 入れた拡張の画面の名前を題に使うため、最後に読んだ拡張を覚える */
let knownExtensions: readonly Extension[] = [];

/**
 * 今の道の画面の題を作る
 * @returns ブラウザの題
 */
const titleNow = () => titleOf(window.location.pathname, withScreens(knownExtensions));

const urlNow = () => window.location.pathname + window.location.search;

/** 最後に描いた画面の道。戻る、進むで画面が変わったかを見る */
let shownPath = window.location.pathname;

/** 画面が変わった事を、題と読み上げに伝える */
function announce() {
  document.title = titleNow();
  // AppShell は中身の main だけを送る。main は AppShell が Tab で入れる形にしているので、tabIndex は変えない
  const main = document.querySelector("main");
  if (main) {
    main.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
}

/**
 * 同じ源の画面へのリンクは読み込み直さず、パスだけを変える
 * @returns 今の URL と、移る関数
 */
function useRoute() {
  const [url, setUrl] = useState(urlNow);
  // 画面が変わった時に、描いた直後に題と読み上げに伝える印
  const moved = useRef(false);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    // 今と同じ所へは履歴を積まない
    const here = window.location.pathname + window.location.search + window.location.hash;
    if (opts?.replace || to === here) {
      window.history.replaceState(null, "", to);
      shownPath = window.location.pathname;
      setUrl(urlNow());
      return;
    }
    window.history.pushState(null, "", to);
    shownPath = window.location.pathname;
    moved.current = true;
    setUrl(urlNow());
  }, []);
  // 新しい画面を描いたのと同じ時に中身へ移る。次の描画まで待つと、その間に押した Tab の行き先を後から中身に戻してしまう
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    announce();
  }, [url]);
  useEffect(() => {
    document.title = titleNow();
    const onPop = () => {
      // 画面が変わった時だけ、先頭へ戻して中身に移る
      if (window.location.pathname !== shownPath) moved.current = true;
      shownPath = window.location.pathname;
      setUrl(urlNow());
    };
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a") : null;
      if (!a) return;
      const link = { href: a.href, attr: (n: string) => a.getAttribute(n) };
      const to = routeOfClick(
        {
          button: e.button,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          defaultPrevented: e.defaultPrevented,
          link,
        },
        window.location,
      );
      if (to === null) return;
      e.preventDefault();
      navigate(to);
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, [navigate]);
  return { url, navigate };
}

function Root() {
  const [health, setHealth] = useState<Health>();
  const [extensions, setExtensions] = useState<readonly Extension[]>([]);
  const { url, navigate } = useRoute();
  useEffect(() => {
    api.api.v1.health
      .$get()
      .then(async (res) => (res.ok ? (await res.json()).data : undefined))
      .then(setHealth)
      .catch(() => setHealth(undefined));
    // 拡張は 100 件までを 1 度に読む。読めない間は拡張の画面を並べない
    api.api.v1.extensions
      .$get({ query: { limit: "100" } })
      .then(async (res) => (res.ok ? (await res.json()).data : []))
      .then(setExtensions)
      .catch(() => setExtensions([]));
  }, []);
  useEffect(() => {
    knownExtensions = extensions;
    document.title = titleNow();
  }, [extensions]);
  const toggleExtension = useCallback(async (id: string, enabled: boolean) => {
    const res = await api.api.v1.extensions[":extensionId"].$put({ param: { extensionId: id }, json: { enabled } }).catch(() => null);
    if (!res?.ok) return;
    const { data } = await res.json();
    setExtensions((cur) => cur.map((e) => (e.id === data.id ? data : e)));
  }, []);
  return (
    <ApiContext value={api}>
      <ExtensionFetchContext value={extensionOrigin}>
        <App health={health} url={url} navigate={navigate} extensions={extensions} toggleExtension={toggleExtension} />
      </ExtensionFetchContext>
    </ApiContext>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
