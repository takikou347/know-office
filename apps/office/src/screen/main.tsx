import "knowidea-tokens/tokens.css";
import "knowidea-css/index.css";
import "./app.css";
import type { Health } from "@know-office/core";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createApi } from "./api.ts";
import { routeOfClick } from "./link.ts";
import { titleOf } from "./routes.ts";

const api = createApi(window.location.origin);

const urlNow = () => window.location.pathname + window.location.search;

/** 最後に描いた画面の道。戻る、進むで画面が変わったかを見る */
let shownPath = window.location.pathname;

/** 画面が変わった事を、題と読み上げに伝える */
function announce() {
  document.title = titleOf(window.location.pathname);
  window.scrollTo(0, 0);
  const main = document.querySelector("main");
  if (main) {
    main.tabIndex = -1;
    main.focus({ preventScroll: true });
  }
}

/** 同じ所の画面へのリンクは読み込み直さず、道だけを変える */
function useRoute() {
  const [url, setUrl] = useState(urlNow);
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
    setUrl(urlNow());
    requestAnimationFrame(announce);
  }, []);
  useEffect(() => {
    document.title = titleOf(window.location.pathname);
    const onPop = () => {
      setUrl(urlNow());
      // 画面が変わった時だけ、先頭へ戻して中身に移る
      if (window.location.pathname !== shownPath) requestAnimationFrame(announce);
      shownPath = window.location.pathname;
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
  const { url, navigate } = useRoute();
  useEffect(() => {
    api.api.health
      .$get()
      .then((res) => (res.ok ? res.json() : undefined))
      .then(setHealth)
      .catch(() => setHealth(undefined));
  }, []);
  return <App health={health} url={url} navigate={navigate} />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
