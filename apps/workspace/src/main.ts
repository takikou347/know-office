// ワークスペースのコンテナの入口。ゲートウェイの鍵を環境変数から取り出し、8080 番でサーバーとエディタの補完の口を起こし、ハートビートを送り始める
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Fetcher, log, systemClock } from "@know-office/core";
import { staffHome, WORK_ROOT } from "./agent.ts";
import { gateReporter } from "./events.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { LspHub } from "./lsp-hub.ts";
import { tscSpawner } from "./lsp-tsc.ts";
import { Runner } from "./run.ts";
import { sdkAgent } from "./sdk.ts";
import { STAFF_GID, STAFF_UID, staffSpawner } from "./spawn.ts";
import { createWorkspaceServer, takeWorkspaceKey } from "./server.ts";
import { TranscriptShipper } from "./transcript.ts";
import { REVIEW_ROOT, TreeStore } from "./tree.ts";

/** ワークスペースのサーバーの番号 */
const PORT = 8080;

// Node の fetch は this を持たずに呼ぶと落ちうるので包む
const fetcher: Fetcher = (url, init) => fetch(url, init);

// 会話の記録は SDK がホームの下に書き、増えた分をゲートウェイに送る。ワークスペースは暗号の鍵を持たない
const transcripts = new TranscriptShipper({ fetcher: (url, init) => fetch(url, init), home: staffHome(), cwd: WORK_ROOT, owner: { uid: STAFF_UID, gid: STAFF_GID } });

// SDK は宛先を変えずに api.anthropic.com を呼び、コンテナの外向きの通信の受け手がゲートウェイの Claude のプロキシに回す
// SDK の子のプロセスは staff に落として起こし、root のサーバーの環境とメモリに触らせない
const runner = new Runner(
  sdkAgent(undefined, staffSpawner()),
  (error) => log("error", "run_failed", { error: error instanceof Error ? error.name : "unknown" }),
  undefined,
  transcripts,
  gateReporter({ fetcher }),
);

// エディタの補完の木は /review に置き、木の node_modules を型の束 (apps/workspace の依存) につなぐ。tsc は利用者 lsp で動かす
// 型の束の実の道は pnpm の置き場 (/opt/workspace/node_modules/.pnpm) の下にあるので、そこを file:///repo/node_modules/ に直す
const lsp = new LspHub({
  trees: new TreeStore({ root: REVIEW_ROOT, bundle: realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url))), clock: systemClock }),
  spawnTsc: tscSpawner(),
  typesRoots: [realpathSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)))],
});

// SDK と社員のコマンドを動かす前に鍵を process.env から消し、子のプロセスに受け継がせない
const key = takeWorkspaceKey(process.env);
createWorkspaceServer(runner, key, lsp).listen(PORT, "0.0.0.0");
// 落ちた事を社員 DO が 90 秒で知れるよう、起きた時から送る
startHeartbeat({ fetcher, clock: systemClock });
