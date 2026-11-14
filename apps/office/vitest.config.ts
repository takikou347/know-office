import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// テストでは Cloudflare の仕組みを読み込まない
export default defineConfig({
  plugins: [react()],
  // e2e は Playwright が本物のブラウザで流す
  test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"] },
});
