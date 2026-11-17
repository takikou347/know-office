// ワークスペースの補完の接続を 1 本だけ持ち、画面との WebSocket を木の tsc につなぐ (仕事とレビューの 3.6)
import { realpathSync } from "node:fs";
import type { LspTreeParams } from "@know-office/core";
import { LspSession } from "./lsp.ts";
import type { TscProcess } from "./lsp-tsc.ts";
import type { TreeStore } from "./tree.ts";

/** 画面との WebSocket のうち、中継が使う所 */
export type LspSocket = {
  /** 1 件送る */
  send(text: string): void;
  /** 閉じる */
  close(code: number, reason: string): void;
  /** 画面から届いた 1 件を受ける */
  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void;
  /** 閉じた時を受ける */
  onClose(listener: () => void): void;
  /** 接続の誤り (枠の大きすぎなど) を受ける。ws は誤りの後に自分で閉じる */
  onError(listener: () => void): void;
};

/** LspHub の依り所 */
export type LspHubDeps = {
  /** 木の置き場 */
  trees: TreeStore;
  /** 木の道を受けて tsc を起こす */
  spawnTsc: (cwd: string) => TscProcess;
  /** 型の束の置き場。実の道 */
  typesRoots: string[];
  /** tsc の RSS を読む。省くと /proc/<pid>/status */
  readRss?: (pid: number) => number | null;
};

/** ワークスペースの補完の接続。1 本だけを持ち、新しい接続を受けてから前の物を閉じる */
export class LspHub {
  /** 木の置き場、tsc の起こし方、型の束 */
  readonly deps: LspHubDeps;
  #active: { session: LspSession; socket: LspSocket } | null = null;

  /**
   * 接続の置き場を作る
   * @param deps 木の置き場、tsc の起こし方、型の束
   */
  constructor(deps: LspHubDeps) {
    this.deps = deps;
  }

  /**
   * 画面との接続を木の tsc につなぐ。使っている間は木を消させない
   * @param params 木の名前。確かめた物だけを渡す
   * @param socket 画面との WebSocket
   */
  open(params: LspTreeParams, socket: LspSocket): void {
    const { trees } = this.deps;
    const tree = realpathSync(trees.dir(params));
    const release = trees.hold(params);
    let tsc: TscProcess;
    try {
      tsc = this.deps.spawnTsc(tree);
    } catch (error) {
      release();
      socket.close(1011, "tsc を起こせない");
      throw error;
    }
    const session = new LspSession({
      tree,
      reviewRoot: realpathSync(trees.deps.root),
      typesRoots: this.deps.typesRoots,
      tsc,
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
      ...(this.deps.readRss === undefined ? {} : { readRss: this.deps.readRss }),
      onEnd: () => {
        release();
        if (this.#active?.session === session) this.#active = null;
      },
    });
    socket.onMessage((data, isBinary) => {
      if (isBinary) socket.close(1003, "文字の 1 件だけを受ける");
      else session.fromScreen(data.toString("utf8"));
    });
    socket.onClose(() => session.end());
    socket.onError(() => {
      socket.close(1009, "接続の誤り");
      session.end();
    });
    const previous = this.#active;
    this.#active = { session, socket };
    // 新しい接続を受けてから前の物を閉じる
    if (previous !== null) {
      previous.socket.close(1008, "新しい接続に替えた");
      previous.session.end();
    }
  }
}
