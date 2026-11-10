import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// テストでは Cloudflare の仕組みを読み込まない
export default defineConfig({
  plugins: [react()],
});
