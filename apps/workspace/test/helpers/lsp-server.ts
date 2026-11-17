// テストでワークスペースのサーバーを補完の口ごと起こし、木を渡し、WebSocket で画面の代わりをする
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@know-office/core";
import { WebSocket } from "ws";
import { LspHub } from "../../src/lsp-hub.ts";
import { type TscProcess, tscSpawner } from "../../src/lsp-tsc.ts";
import { Runner } from "../../src/run.ts";
import { createWorkspaceServer } from "../../src/server.ts";
import { TreeStore } from "../../src/tree.ts";
import { type FakeTsc, fakeTsc } from "./fake-tsc.ts";
import { parse } from "./relay.ts";

/** ゲートウェイの鍵 */
export const KEY = "k".repeat(64);

/** 画面の側の WebSocket の様子 */
export type Client = {
  /** 接続 */
  socket: WebSocket;
  /** 受けた物 */
  received: Record<string, unknown>[];
  /** 閉じた code */
  closed: Promise<number>;
};

/** 起こしたサーバーの様子 */
export type LspServer = {
  /** 一時の置き場。テストごとに作り直す */
  base: () => string;
  /** 木を置く所 */
  root: () => string;
  /** 起こした代わりの tsc */
  tscs: FakeTsc[];
  /** tsc を起こした木の道 */
  spawned: string[];
  /** true にすると本物の tsc を利用者を落とさずに起こす */
  useRealTsc: (real: boolean) => void;
  /** 番号を決めて待ち受ける */
  start: () => Promise<void>;
  /** 止める */
  stop: () => Promise<void>;
  /** テストごとに置き場と記録を作り直す */
  reset: () => void;
  /** 置き場を消す */
  clean: () => void;
  /** HTTP の頭 */
  http: () => string;
  /** 木を受けさせる */
  put: (path: string, body: Buffer, key?: string | null) => Promise<Response>;
  /** 切り替えを求める。開けなければステータス */
  connect: (query: string, key?: string | null) => Promise<Client | number>;
};

/**
 * 補完の口を持つサーバーを作る
 * @returns サーバーの様子
 */
export function lspServer(): LspServer {
  let base = "";
  let trees: TreeStore | null = null;
  let real = false;
  let port = 0;
  const tscs: FakeTsc[] = [];
  const spawned: string[] = [];
  const hub = new LspHub({
    get trees(): TreeStore {
      if (trees === null) throw new Error("置き場が無い");
      return trees;
    },
    spawnTsc: (cwd: string): TscProcess => {
      spawned.push(cwd);
      if (real) return tscSpawner(undefined, { asLsp: false })(cwd);
      const tsc = fakeTsc(5000 + tscs.length);
      tscs.push(tsc);
      return tsc.proc;
    },
    typesRoots: [realpathSync(new URL("../../../../node_modules", import.meta.url))],
    readRss: () => 0,
  });
  const server: Server = createWorkspaceServer(
    new Runner(
      () => new Promise(() => {}),
      () => {},
    ),
    KEY,
    hub,
  );
  return {
    base: () => base,
    root: () => join(base, "review"),
    tscs,
    spawned,
    useRealTsc: (value) => {
      real = value;
    },
    start: async () => {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("番号が取れない");
      port = address.port;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
    reset: () => {
      base = realpathSync(mkdtempSync(join(tmpdir(), "ko-lsp-")));
      trees = new TreeStore({ root: join(base, "review"), bundle: realpathSync(new URL("../../node_modules", import.meta.url)), clock: systemClock });
      tscs.length = 0;
      spawned.length = 0;
      real = false;
    },
    clean: () => rmSync(base, { recursive: true, force: true }),
    http: () => `http://127.0.0.1:${port}`,
    put: (path, body, key = KEY) => fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT", headers: { "content-type": "application/gzip", ...(key === null ? {} : { authorization: `Bearer ${key}` }) }, body }),
    connect: (query, key = KEY) =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/lsp${query}`, { headers: key === null ? {} : { authorization: `Bearer ${key}` } });
        const received: Record<string, unknown>[] = [];
        const closed = new Promise<number>((done) => socket.once("close", (code) => done(code)));
        socket.on("message", (data: Buffer) => received.push(parse(data.toString("utf8"))));
        socket.once("open", () => resolve({ socket, received, closed }));
        socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        socket.once("error", () => resolve(0));
      }),
  };
}

/**
 * 求めを送り、同じ id の返事を待つ
 * @param client 接続
 * @param id 求めの id
 * @param method method
 * @param params params
 * @returns 返事
 */
export async function request(client: Client, id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  client.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  for (let n = 0; n < 400; n += 1) {
    const found = client.received.find((message) => message.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${method} の返事が来ない`);
}

/**
 * 知らせを送る
 * @param client 接続
 * @param method method
 * @param params params
 */
export function notify(client: Client, method: string, params: unknown): void {
  client.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}
