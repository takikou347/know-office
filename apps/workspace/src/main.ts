// ワークスペースのコンテナの入口。ゲートウェイの鍵を環境変数から取り出し、8080 番でサーバーを起こす
import { log } from "@know-office/core";
import { staffHome, WORK_ROOT } from "./agent.ts";
import { Runner } from "./run.ts";
import { sdkAgent } from "./sdk.ts";
import { STAFF_GID, STAFF_UID, staffSpawner } from "./spawn.ts";
import { createWorkspaceServer, takeWorkspaceKey } from "./server.ts";
import { TranscriptShipper } from "./transcript.ts";

/** ワークスペースのサーバーの番号 */
const PORT = 8080;

// 会話の記録は SDK がホームの下に書き、増えた分をゲートウェイに送る。ワークスペースは暗号の鍵を持たない
const transcripts = new TranscriptShipper({ fetcher: (url, init) => fetch(url, init), home: staffHome(), cwd: WORK_ROOT, owner: { uid: STAFF_UID, gid: STAFF_GID } });

// SDK は宛先を変えずに api.anthropic.com を呼び、コンテナの外向きの通信の受け手がゲートウェイの Claude のプロキシに回す
// SDK の子のプロセスは staff に落として起こし、root のサーバーの環境とメモリに触らせない
const runner = new Runner(sdkAgent(undefined, staffSpawner()), (error) => log("error", "run_failed", { error: error instanceof Error ? error.message : "unknown" }), undefined, transcripts);

// SDK と社員のコマンドを動かす前に鍵を process.env から消し、子のプロセスに受け継がせない
const key = takeWorkspaceKey(process.env);
createWorkspaceServer(runner, key).listen(PORT, "0.0.0.0");
