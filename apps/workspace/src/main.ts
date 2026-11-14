// ワークスペースのコンテナの入口。8080 番でサーバーを起こす
import { AppError, log } from "@know-office/core";
import { Runner } from "./run.ts";
import { createWorkspaceServer } from "./server.ts";

/** ワークスペースのサーバーの番号 */
const PORT = 8080;

// Claude Agent SDK は tasks.md の 7.6 でつなぐ。それまではタスクを受けても SDK を呼べない事を知らせて終える
const runner = new Runner(
  () => Promise.reject(new AppError("unavailable", "SDK がまだつながっていない")),
  (error) => log("error", "run_failed", { error: error instanceof Error ? error.message : "unknown" }),
);

createWorkspaceServer(runner).listen(PORT, "0.0.0.0");
