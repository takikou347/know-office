import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devFakes } from "./dev/plugin.ts";

// 画面と入口を 1 つの Worker にまとめて作る
export default defineConfig({
  // 開発の時だけ、代わりの物を cloudflare より前に置き、API への要求に証明を付ける
  plugins: [devFakes(), react(), cloudflare()],
});
