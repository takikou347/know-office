// テストで補完の中継を代わりの tsc につなぎ、画面に送った物と閉じた訳を集める
import { vi } from "vitest";
import { LspSession } from "../../src/lsp.ts";
import { type FakeTsc, fakeTsc, flush } from "./fake-tsc.ts";

export const NODE = "0190f4a8-0000-7000-8000-000000000101";
export const SHA = "a".repeat(40);
export const REVIEW = "/review";
export const TREE = `${REVIEW}/${NODE}/${SHA}`;
export const TYPES = "/opt/workspace/node_modules";
export const OTHER_TREE = `${REVIEW}/0190f4a8-0000-7000-8000-000000000102/${"b".repeat(40)}`;

/** 中継の様子 */
export type Relay = {
  /** 中継 */
  session: LspSession;
  /** 代わりの tsc */
  tsc: FakeTsc;
  /** 画面に送った物 */
  sent: Record<string, unknown>[];
  /** 閉じた code と訳 */
  closed: { code: number; reason: string }[];
  /** 終えた回数 */
  ended: () => number;
  /** 読ませる RSS を決める */
  setRss: (bytes: number | null) => void;
  /** 画面から 1 件送り、届くまで待つ */
  screen: (message: unknown) => Promise<void>;
  /** tsc から 1 件送り、届くまで待つ */
  fromTsc: (message: unknown) => Promise<void>;
};

/**
 * 項目を持つ物として読む
 * @param value 値
 * @returns 項目を持つ物
 */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("項目を持つ物でない");
  return Object.fromEntries(Object.entries(value));
}

/**
 * 並びとして読む
 * @param value 値
 * @returns 並び
 */
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("並びでない");
  return value.map((item: unknown) => item);
}

/**
 * JSON を項目を持つ物として読む
 * @param text JSON
 * @returns 項目を持つ物
 */
export function parse(text: string): Record<string, unknown> {
  return record(JSON.parse(text));
}

/**
 * 時刻を偽にして中継を代わりの tsc につなぐ。終わる時は session.end() と vi.useRealTimers() を呼ぶ
 * @returns 中継の様子
 */
export function relay(): Relay {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const tsc = fakeTsc();
  const sent: Record<string, unknown>[] = [];
  const closed: { code: number; reason: string }[] = [];
  let rss: number | null = 100 * 1024 * 1024;
  let ended = 0;
  const session = new LspSession({
    tree: TREE,
    reviewRoot: REVIEW,
    typesRoots: [TYPES],
    tsc: tsc.proc,
    send: (text) => sent.push(parse(text)),
    close: (code, reason) => closed.push({ code, reason }),
    readRss: () => rss,
    onEnd: () => {
      ended += 1;
    },
  });
  return {
    session,
    tsc,
    sent,
    closed,
    ended: () => ended,
    setRss: (bytes) => {
      rss = bytes;
    },
    screen: async (message) => {
      session.fromScreen(typeof message === "string" ? message : JSON.stringify(message));
      await flush();
    },
    fromTsc: async (message) => {
      tsc.reply(message);
      await flush();
      await flush();
    },
  };
}
