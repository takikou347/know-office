import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// テストでは Cloudflare の仕組みを読み込まない
export default defineConfig({
  plugins: [react()],
  // e2e は Playwright が本物のブラウザで流す
  // D1 と workerd を beforeEach で起こすファイルがあり、ほかの検証と重なると 10 秒を超えうるので、前後の処理は 30 秒まで待つ
  test: { include: ["test/**/*.test.{ts,tsx}"], hookTimeout: 30_000 },
});
