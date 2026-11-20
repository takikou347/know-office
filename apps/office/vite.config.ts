import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devFakes } from "./dev/plugin.ts";
import { zodEnglishOnly } from "./scripts/zod-locales.ts";
import { CSP_NONCE_PLACEHOLDER } from "./src/gate/screen-html.ts";

// 画面の通しは KO_PERSIST_DIR で D1 と DO の置き場を替え、開発の置き場 (.wrangler/state) に触らない (e2e/helpers/state.ts)
const persistDir = process.env["KO_PERSIST_DIR"];

// 画面と入口を 1 つの Worker にまとめて作る
export default defineConfig({
  // 開発と build した画面のプレビューの時だけ、代わりの物を cloudflare より前に置き、API への要求に証明を付ける。build の画面だけ Zod の訳を英語にする
  plugins: [devFakes(), zodEnglishOnly(), react(), cloudflare({ persistState: persistDir ? { path: persistDir } : true })],
  // index.html の meta と script、style に nonce の置き場を入れる。入口 (src/gate/screen-html.ts) が要求ごとの値に替える
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  // 遅れて読む画面 (コードの差分、オフィスの 3D) を起動の時に先に変換し、最初に開いた時の待ちを除く。CI の冷えたサーバーで e2e が待ちきれずに落ちた
  // 画面の通しでは Vite のエラーの重ね表示を出さない。重ね表示は開いている全部の画面に配られるので、Worker への中継が一時に落ちると、落ちた要求と関わらない同時の通しの画面にも出て、a11y のチェックが重ね表示の中身を拾う
  server: { warmup: { clientFiles: ["./src/screen/pages/staff/ReviewEditor.tsx", "./src/screen/pages/office/OfficeScene.tsx"] }, ...(persistDir ? { hmr: { overlay: false } } : {}) },
});
