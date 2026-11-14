// ワークスペースのコンテナの入口。ゲートウェイの鍵を環境変数から取り出し、8080 番でサーバーを起こす
import { log } from "@know-office/core";
import { Runner } from "./run.ts";
import { sdkAgent } from "./sdk.ts";
import { createWorkspaceServer, takeWorkspaceKey } from "./server.ts";

/** ワークスペースのサーバーの番号 */
const PORT = 8080;

// SDK は宛先を変えずに api.anthropic.com を呼び、コンテナの外向きの通信の受け手がゲートウェイの Claude のプロキシに回す
const runner = new Runner(sdkAgent(), (error) => log("error", "run_failed", { error: error instanceof Error ? error.message : "unknown" }));

// SDK と社員のコマンドを動かす前に鍵を process.env から消し、子のプロセスに受け継がせない。/proc/<pid>/environ には残る
const key = takeWorkspaceKey(process.env);
createWorkspaceServer(runner, key).listen(PORT, "0.0.0.0");
