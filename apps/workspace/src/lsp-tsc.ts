// 補完の tsc --lsp を、社員とサーバーと違う利用者 lsp で起こし、RSS を読む (社員が考えるの 2 章、3.2)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { AppError } from "@know-office/core";

/** 補完の tsc を動かす利用者 lsp の uid。Dockerfile の useradd と同じ */
export const LSP_UID = 10002;
/** 補完の tsc を動かす組 lsp の gid。Dockerfile の groupadd と同じ */
export const LSP_GID = 10002;
/** tsc の Go のメモリの目安。basic の 1GiB でサーバーと SDK と社員のコマンドに場所を残す */
export const TSC_MEMORY_LIMIT = "256MiB";
/** tsc を止める RSS。目安を超えて GC が追いつかない時に、コンテナのメモリを使い切る前に止める */
export const TSC_RSS_LIMIT_BYTES = 384 * 1024 * 1024;

/** tsc のプロセスのうち、中継が使う所 */
export type TscProcess = {
  /** プロセスの番号 */
  pid?: number | undefined;
  /** tsc の stdin */
  stdin: Writable;
  /** tsc の stdout */
  stdout: Readable;
  /** 止める */
  kill(signal?: NodeJS.Signals): boolean;
  /** 終わりを待つ */
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

/** tscSpawner の依り所。テストは起こさずに渡した物を見る */
export type TscSpawnDeps = {
  /** 子のプロセスを起こす関数。本物は node:child_process の spawn */
  spawn: (command: string, args: string[], options: Record<string, unknown>) => unknown;
  /** サーバーの uid */
  uid: () => number;
};

const NODE_DEPS: TscSpawnDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  uid: () => process.getuid?.() ?? -1,
};

/**
 * typescript の tsc の入口の道を返す。入口は Node で Go の tsc を同じ番号のまま execve する
 * @returns 道
 */
function tscBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
}

/**
 * tsc --lsp を、利用者 lsp、nice 10、GOMEMLIMIT で起こす関数を作る。環境変数はサーバーの物を受け継がない
 * uid と gid を落とすと libuv が補助の組も外すので、tsc は root と staff の組を持たず、/work と両方のプロセスの /proc を読めない
 * @param deps 起こす関数と、サーバーの uid。省くと本物
 * @param options asLsp を false にすると利用者を落とさない。手元の代わりのワークスペースだけが使う
 * @param options.asLsp 利用者 lsp に落とすか
 * @returns 木の道を受けて tsc を起こす関数
 */
export function tscSpawner(deps: TscSpawnDeps = NODE_DEPS, options: { asLsp: boolean } = { asLsp: true }): (cwd: string) => TscProcess {
  const bin = tscBin();
  return (cwd) => {
    // 落とせないまま同じ利用者で起こすと、tsc がサーバーの鍵と社員の作業を読めるので起こさない
    if (options.asLsp && deps.uid() !== 0) throw new AppError("internal", "サーバーが root でないので、tsc を lsp に落として起こせない");
    const user = options.asLsp ? { uid: LSP_UID, gid: LSP_GID } : {};
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return deps.spawn("/usr/bin/nice", ["-n", "10", process.execPath, bin, "--lsp", "--stdio"], {
      cwd,
      ...user,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", GOMEMLIMIT: TSC_MEMORY_LIMIT },
      stdio: ["pipe", "pipe", "ignore"],
    }) as TscProcess;
  };
}

/**
 * /proc/<pid>/status の VmRSS を読む
 * @param pid プロセスの番号
 * @returns バイト数。読めなければ null
 */
export function procRss(pid: number): number | null {
  try {
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match?.[1] === undefined ? null : Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

