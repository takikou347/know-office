// エディタの補完のテストの手伝い。手で進める時計、接続の代わり、ワークスペースの代わり、手元の記憶 (タスクとレビューの 3.6)
import type { LspBox } from "../../src/gate/work/editor-lsp.ts";
import type { RelaySocket, RelayTimers } from "../../src/gate/work/lsp-relay.ts";

/** 手で進める時計と、時間が来たら呼ぶ物 */
export class ManualTimers implements RelayTimers {
  at: number;
  #tasks: { at: number; fn: () => void; id: number }[] = [];
  #serial = 0;

  /**
   * 時計を作る
   * @param start 始めの時刻
   */
  constructor(start: number) {
    this.at = start;
  }

  now = (): number => this.at;
  after = (ms: number, fn: () => void): (() => void) => {
    const id = (this.#serial += 1);
    this.#tasks.push({ at: this.at + ms, fn, id });
    return () => {
      this.#tasks = this.#tasks.filter((t) => t.id !== id);
    };
  };
  /**
   * 時計を進め、来た物を順に呼ぶ
   * @param ms 進める長さ
   */
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      const due = this.#tasks.filter((t) => t.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#tasks = this.#tasks.filter((t) => t.id !== due.id);
      this.at = due.at;
      due.fn();
    }
    this.at = end;
  }
}

/** 送った物と閉じた番号を覚える接続 */
export type FakeSocket = RelaySocket & { sent: string[]; closed: { code: number; reason: string } | null };

/**
 * 接続の代わりを作る
 * @returns 接続
 */
export function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closed: null,
    send: (data) => void socket.sent.push(data),
    close: (code, reason) => {
      socket.closed ??= { code, reason };
    },
  };
  return socket;
}

/**
 * 合図で終わる約束を作る
 * @returns 約束と終わらせる関数
 */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let done: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: () => done?.() };
}

/** ワークスペースの代わり。起こした回数、止めた回数、木の受け取りを覚える */
export type FakeBox = LspBox & { wakes: number; stops: number; puts: string[]; trees: Map<string, string>; wakeFails: boolean; stopGate: Promise<void> | null; putFails: boolean; isRunning: boolean };

/**
 * ワークスペースの代わりを作る
 * @param running 初めから動いているか
 * @returns 代わり
 */
export function fakeBox(running = false): FakeBox {
  let stopping: Promise<void> | null = null;
  const box: FakeBox = {
    isRunning: running,
    get running() {
      return box.isRunning;
    },
    wakes: 0,
    stops: 0,
    puts: [],
    trees: new Map(),
    wakeFails: false,
    stopGate: null,
    putFails: false,
    settled: async () => {
      await stopping;
    },
    wakeOnce: async () => {
      await stopping;
      box.wakes += 1;
      if (box.wakeFails) throw Object.assign(new Error("起きない"), { code: "unavailable" });
      box.isRunning = true;
    },
    stop: async () => {
      box.stops += 1;
      stopping = (async () => {
        await box.stopGate;
        box.isRunning = false;
      })();
      await stopping;
      stopping = null;
    },
    lspTreeSha: (nodeId) => Promise.resolve(box.trees.get(nodeId) ?? null),
    putLspTree: async (nodeId, sha, body) => {
      // 本物の WorkspaceBox と同じく、流れが落ちて送れなかった事は届かない事 (unavailable) として返る
      await new Response(body).arrayBuffer().catch(() => {
        throw Object.assign(new Error("ワークスペースに届かない"), { code: "unavailable" });
      });
      if (box.putFails) throw Object.assign(new Error("木を断った"), { code: "upstream_failed" });
      box.puts.push(`${nodeId}:${sha}`);
      box.trees.set(nodeId, sha);
    },
  };
  return box;
}

/**
 * 手元の記憶を作る
 * @returns 記憶
 */
export function memory(): { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } {
  const map = new Map<string, unknown>();
  return { get: (key) => Promise.resolve(structuredClone(map.get(key))), put: (key, value) => Promise.resolve(void map.set(key, structuredClone(value))) };
}

