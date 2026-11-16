import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// テストでは Cloudflare の仕組みを読み込まない
export default defineConfig({
  plugins: [react()],
  // e2e は Playwright が本物のブラウザで流す
  // D1 と workerd はファイルの初めのテストの前で起こし、ほかの検証と重なると 10 秒を超えうるので、前後の処理は 30 秒まで待つ
  // タスクの流れを通しで歩くテストは手元で 2 秒ほどかかり、CI の 2 コアで全ファイルを並べて走らせると 5 秒を超えたので、1 件は 20 秒まで待つ
  // ファイルごとに worker を作り直すと、読み込みだけで 1 ファイル 1 秒ほどかかるので、isolate を切って worker の中で読んだ物を使い回す。ファイルごとの片付けは setupFiles に置く
  test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"], isolate: false, hookTimeout: 30_000, testTimeout: 20_000 },
});
