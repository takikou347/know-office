import type { Health } from "@know-office/core";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createApi } from "./api.ts";

const api = createApi(window.location.origin);

function Root() {
  const [health, setHealth] = useState<Health>();
  useEffect(() => {
    api.api.health
      .$get()
      .then((res) => (res.ok ? res.json() : undefined))
      .then(setHealth)
      .catch(() => setHealth(undefined));
  }, []);
  return <App health={health} />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
