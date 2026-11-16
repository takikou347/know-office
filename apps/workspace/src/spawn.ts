// SDK の子のプロセス (Claude Code と社員のコマンド) を、サーバーと違う利用者の staff に落として起こす (社員が考えるの 3.2)
import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { AppError } from "@know-office/core";

/** 社員の利用者 staff の uid。Dockerfile の useradd と同じ */
export const STAFF_UID = 10001;
/** 社員の組 office の gid。Dockerfile の groupadd と同じ */
export const STAFF_GID = 10001;

/** staffSpawner の依り所。テストは起こさずに渡した物を見る */
export type SpawnerDeps = {
  /** 子のプロセスを起こす関数。本物は node:child_process の spawn */
  spawn: (command: string, args: string[], options: Record<string, unknown>) => unknown;
  /** サーバーの uid */
  uid: () => number;
};

const NODE_DEPS: SpawnerDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  uid: () => process.getuid?.() ?? -1,
};

/**
 * SDK の spawnClaudeCodeProcess に渡す、子のプロセスを staff で起こす関数を作る
 * uid と gid を落とすと libuv が補助の組も外すので、子は root の組を持たない。社員はサーバーの環境、メモリ、8080 番に触れない
 * @param deps 起こす関数と、サーバーの uid。省くと本物
 * @returns SDK の options の spawnClaudeCodeProcess
 */
export function staffSpawner(deps: SpawnerDeps = NODE_DEPS): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    // 落とせないまま同じ利用者で起こすと、社員がサーバーの鍵を読めるので起こさない
    if (deps.uid() !== 0) throw new AppError("internal", "サーバーが root でないので、社員を staff に落として起こせない");
    // stderr は SDK の既定と同じく読まない。社員のコマンドの出力をサーバーのログに混ぜない
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return deps.spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, uid: STAFF_UID, gid: STAFF_GID, stdio: ["pipe", "pipe", "ignore"] }) as SpawnedProcess;
  };
}
