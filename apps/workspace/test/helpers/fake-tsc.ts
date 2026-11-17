// テストで tsc --lsp の代わりをする。受けた JSON-RPC を集め、決めた物を返す
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** 代わりの tsc */
export type FakeTsc = {
  /** 中継に渡すプロセス */
  proc: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; kill(signal?: NodeJS.Signals): boolean };
  /** tsc が受けた物 */
  received: Record<string, unknown>[];
  /** 受けた合図 */
  signals: string[];
  /**
   * tsc から 1 件送る
   * @param message JSON-RPC の 1 件
   */
  reply(message: unknown): void;
};

/**
 * 1 件を LSP の枠 (Content-Length) に入れる
 * @param message JSON-RPC の 1 件
 * @returns 枠に入れた物
 */
export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]);
}

/**
 * 代わりの tsc を作る
 * @param pid プロセスの番号
 * @returns 代わりの tsc
 */
export function fakeTsc(pid = 4242): FakeTsc {
  const received: Record<string, unknown>[] = [];
  const signals: string[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
      signals.push(signal);
      emitter.emit("exit", null, signal);
      return true;
    },
  });
  let buffer = Buffer.alloc(0);
  stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? "-1");
      if (buffer.byteLength < end + 4 + length) return;
      const message: unknown = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      if (typeof message === "object" && message !== null && !Array.isArray(message)) received.push(Object.fromEntries(Object.entries(message)));
      buffer = buffer.subarray(end + 4 + length);
    }
  });
  return { proc, received, signals, reply: (message) => stdout.write(frame(message)) };
}

/**
 * 流れの中の物が届くまで待つ
 * @returns 待ち
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
