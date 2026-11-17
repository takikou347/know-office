// エディタの補完の中身のテストの手伝い。補完の中身を作る、1 本つなぐ、開いたままにする、書く所で止める記憶 (タスクとレビューの 3.6)
import { EditorLsp, type EditorStorage } from "../../src/gate/work/editor-lsp.ts";
import type { LspRelay } from "../../src/gate/work/lsp-relay.ts";
import { type FakeBox, type FakeSocket, fakeSocket, ManualTimers, memory } from "./lsp.ts";

export const NODE = "0190f4a8-0000-7000-8000-000000000101";
export const SHA = "c".repeat(40);
export const OLD = "d".repeat(40);
/** 日本時間の 2026-11-17 の 20 時。勤務の外 */
export const T0 = Date.UTC(2026, 10, 17, 11);

/**
 * 投げられた物の code を読む。RPC を越えた誤りと同じく code だけを見る
 * @param error 投げられた物
 * @returns code。無ければ空
 */
export function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

/** 書く所で止められる記憶。gate を置くと、書いた後に gate が開くまで返らない */
export type GatedStorage = EditorStorage & { gate: Promise<void> | null; read(): Promise<{ by: string | null; wokeAt: number | null; usedMs: number }> };

/**
 * 書く所で止められる記憶を作る
 * @returns 記憶
 */
export function gatedStorage(): GatedStorage {
  const inner = memory();
  const storage: GatedStorage = {
    gate: null,
    get: (key) => inner.get(key),
    put: async (key, value) => {
      await inner.put(key, value);
      await storage.gate;
    },
    read: async () => {
      const value: unknown = await inner.get("editor");
      if (typeof value !== "object" || value === null) throw new Error("記憶が無い");
      return { by: "by" in value && typeof value.by === "string" ? value.by : null, wokeAt: "wokeAt" in value && typeof value.wokeAt === "number" ? value.wokeAt : null, usedMs: "usedMs" in value && typeof value.usedMs === "number" ? value.usedMs : -1 };
    },
  };
  return storage;
}

/**
 * 待っている約束を先に進める
 * @returns 無し
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 補完の中身を作る
 * @param box ワークスペースの代わり
 * @param storage 記憶。省くと手元の物
 * @returns 中身、時計、掛けた alarm
 */
export function editorWith(box: FakeBox, storage: EditorStorage = memory()): { editor: EditorLsp; timers: ManualTimers; alarms: number[]; ended: string[] } {
  const timers = new ManualTimers(T0);
  const alarms: number[] = [];
  const ended: string[] = [];
  const editor = new EditorLsp({ box, storage, timers, setAlarm: (at) => Promise.resolve(void alarms.push(at)), onRelayEnd: (meta) => void ended.push(meta.sessionId) });
  return { editor, timers, alarms, ended };
}

/**
 * 1 本つなぐまでを進める。支度して、要るなら木を渡し、中継を付ける
 * @param editor 補完の中身
 * @param now 時刻
 * @param wake 起こしてよいか
 * @param sessionId ログインセッション
 * @returns 画面の側の接続
 */
export async function connect(editor: EditorLsp, now: number, wake = true, sessionId = "s1"): Promise<FakeSocket & { relay: LspRelay }> {
  const prepared = await editor.prepare({ nodeId: NODE, sha: SHA, wake, now });
  if (prepared.claim !== null) await editor.putTree(NODE, SHA, prepared.claim, new Response("木").body ?? new ReadableStream());
  const screen = fakeSocket();
  return Object.assign(screen, { relay: editor.attach(screen, fakeSocket(), { sessionId, ip: "203.0.113.1", openedAt: now }) });
}

/**
 * 画面から 5 分ごとに送りながら時計を進め、接続を開いたままにする
 * @param screen 開いた接続
 * @param screen.relay 中継
 * @param timers 時計
 * @param ms 進める長さ
 */
export function keepOpen(screen: { relay: LspRelay }, timers: ManualTimers, ms: number): void {
  for (let left = ms; left > 0; left -= Math.min(left, 5 * 60_000)) {
    timers.advance(Math.min(left, 5 * 60_000));
    screen.relay.fromScreen("{}");
  }
}

