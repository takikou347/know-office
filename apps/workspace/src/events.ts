// 働いた事 (発言、終わり、エラー) をゲートウェイの POST /ws/v1/events に作業トークン付きで届ける (社員が考えるの 3.2、3.7)
import { type AgentEvent, allowedFetch, type Fetcher, log } from "@know-office/core";
import { GATE_ORIGIN } from "./hooks.ts";
import type { Reporter } from "./run.ts";

/** 出来事を送るルート */
export const GATE_EVENTS_URL = `${GATE_ORIGIN}ws/v1/events`;

/** 終わりを送り直す回数。初めの 1 回と合わせて 3 回 */
const RESULT_ATTEMPTS = 3;
/** 送り直す前に待つ長さ (2 秒) */
const RETRY_WAIT_MS = 2000;
/** 外を呼ぶ時の待ち (10 秒) */
const TIMEOUT_MS = 10_000;

/** 届ける口の依り所 */
export type ReporterDeps = {
  /** ゲートウェイを呼ぶ関数 */
  fetcher: Fetcher;
  /** 送り直す前に待つ。テストは待たない */
  wait?: (ms: number) => Promise<void>;
};

/**
 * 1 回送る
 * @param deps 依り所
 * @param ticket 作業トークン
 * @param events 出来事
 * @returns 返事のステータス。届かなければ null
 */
async function post(deps: ReporterDeps, ticket: string, events: AgentEvent[]): Promise<number | null> {
  try {
    const res = await allowedFetch(deps.fetcher, GATE_EVENTS_URL, [GATE_ORIGIN], {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

/**
 * 今の作業トークンで送り、401 の間に作業トークンが差し替わっていれば、新しい物で 1 回だけ送り直す
 * ゲートウェイは渡し終えた後に前の作業トークンを失効させるので、その間に前の物で送ると 401 になる。401 は何も書いていないので、送り直しても二重にならない
 * @param deps 依り所
 * @param ticket 今の作業トークンを返す関数
 * @param events 出来事
 * @returns 返事のステータス。届かなければ null
 */
async function postFresh(deps: ReporterDeps, ticket: () => string, events: AgentEvent[]): Promise<number | null> {
  const used = ticket();
  const status = await post(deps, used, events);
  if (status !== 401 || ticket() === used) return status;
  return post(deps, ticket(), events);
}

/**
 * ゲートウェイに届ける口を作る
 * 発言とエラーは、届いたか分からない時に送り直すと二重に残るので 1 回だけ送る。終わりはゲートウェイが今のタスクで確かめて一度だけ効くので、届かない時と 5xx の時だけ送り直す
 * @param deps ゲートウェイを呼ぶ関数と待ち方
 * @returns Reporter
 */
export function gateReporter(deps: ReporterDeps): Reporter {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async report(ticket, events) {
      const said = events.filter((e) => e.kind !== "result");
      const results = events.filter((e) => e.kind === "result");
      if (said.length > 0) {
        const status = await postFresh(deps, ticket, said);
        if (status === null || status >= 300) log("warn", "events_send_failed", { status: status ?? 0 });
      }
      if (results.length === 0) return;
      for (let attempt = 1; attempt <= RESULT_ATTEMPTS; attempt += 1) {
        const status = await postFresh(deps, ticket, results);
        if (status !== null && status < 500) {
          if (status >= 300) log("warn", "events_send_failed", { status });
          return;
        }
        if (attempt < RESULT_ATTEMPTS) await wait(RETRY_WAIT_MS);
      }
      log("warn", "events_send_failed", { status: 0 });
    },
  };
}
