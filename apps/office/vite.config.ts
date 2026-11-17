import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devFakes } from "./dev/plugin.ts";

// 画面の通しは KO_PERSIST_DIR で D1 と DO の置き場を替え、開発の置き場 (.wrangler/state) に触らない (e2e/helpers/state.ts)
const persistDir = process.env["KO_PERSIST_DIR"];

// 画面と入口を 1 つの Worker にまとめて作る
export default defineConfig({
  // 開発の時だけ、代わりの物を cloudflare より前に置き、API への要求に証明を付ける
  plugins: [devFakes(), react(), cloudflare({ persistState: persistDir ? { path: persistDir } : true })],
  // 遅れて読む画面 (コードの差分、オフィスの 3D) を起動の時に先に変換し、最初に開いた時の待ちを除く。CI の冷えたサーバーで e2e が待ちきれずに落ちた
  server: { warmup: { clientFiles: ["./src/screen/pages/staff/ReviewEditor.tsx", "./src/screen/pages/office/OfficeScene.tsx"] } },
});
