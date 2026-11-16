// テストのゲートウェイの社員 DO とワークスペースの DO の代わりのうち、呼び出しの始め方 (arm、runState、markRun、run) と、開発の通しの forgetDay と鍵の確かめを持つ所 (社員が考えるの 3.2)
import { AppError, type StaffId } from "@know-office/core";
import type { Bindings } from "../../src/gate/env.ts";
import type { StaffBook } from "../../src/gate/work/staff-book.ts";
import { continueRun } from "../../src/gate/work/transcript.ts";

/** 社員とタスクごとの呼び出しの様子 */
export type RunMarks = Map<string, { started: boolean; failures: number }>;

/**
 * 社員 1 人の arm、runState、markRun、forgetDay の代わりを作る。本物は呼び出しを待たずに始めるが、テストは結果を確かめるので待つ
 * @param env バインディング
 * @param id 社員 ID
 * @param book 社員の勤務の本
 * @param marks 呼び出しの様子の置き場。社員をまたいで 1 つ
 * @returns 社員 DO の代わりに足すメソッド
 */
export function staffRunFakes(env: Bindings, id: StaffId, book: StaffBook, marks: RunMarks) {
  return {
    forgetDay: async (now: number) => {
      await book.forgetDay(now);
      return null;
    },
    arm: async (now: number) => {
      await book.wake(now);
      const { state, nodeId } = await book.status(now);
      if (nodeId !== null && (state === "working" || state === "called") && !(marks.get(`${id}:${nodeId}`)?.started ?? false)) await continueRun(env, id, now);
      return { alarm: null };
    },
    runState: async (nodeId: string) => {
      const mark = marks.get(`${id}:${nodeId}`);
      return { promptVersion: await book.promptVersionOf(nodeId), started: mark?.started ?? false, failures: mark?.failures ?? 0 };
    },
    markRun: (nodeId: string, mark: "started" | "failed" | "done") => {
      const key = `${id}:${nodeId}`;
      const was = marks.get(key) ?? { started: false, failures: 0 };
      if (mark === "done") marks.delete(key);
      else marks.set(key, mark === "started" ? { ...was, started: true } : { started: false, failures: was.failures + 1 });
      return Promise.resolve({ failures: marks.get(key)?.failures ?? 0 });
    },
  };
}

/** ワークスペースの DO の代わりが受けた物 */
export type WorkspaceSeen = {
  /** 受けた作業トークン */
  tickets: string[];
  /** 受けた runs の入力 */
  runs: unknown[];
  /** true なら届かない */
  down: boolean;
  /** 起こした時に渡した鍵。起こしていなければ無い */
  key?: string;
};

/**
 * ワークスペースの DO の代わりを作る。down の間は届かない
 * @param seen 受けた物を足す先
 * @returns replaceTicket、run、holdsKey
 */
export function workspaceFake(seen: WorkspaceSeen) {
  return {
    holdsKey: (key: string) => Promise.resolve(seen.key !== undefined && seen.key === key),
    replaceTicket: (ticket: string) => {
      if (seen.down) return Promise.reject(new Error("ワークスペースに届かない"));
      seen.tickets.push(ticket);
      return Promise.resolve(null);
    },
    run: (input: unknown) => {
      if (seen.down) return Promise.reject(new AppError("unavailable", "ワークスペースに届かない"));
      seen.runs.push(input);
      return Promise.resolve(null);
    },
  };
}
