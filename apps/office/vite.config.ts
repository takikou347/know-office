import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 画面と入口を 1 つの Worker にまとめて作る
export default defineConfig({
  plugins: [react(), cloudflare()],
});
