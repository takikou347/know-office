// タスク 1 件分の SDK の呼び出しを持ち、作業トークンが差し替わったら今の呼び出しを終えて続きから呼び直す (社員が考えるの 3.2)
import { AppError, log, type RunInput, systemClock } from "@know-office/core";
import { type Agent, agentOptions } from "./agent.ts";
import { type HookDeps, preToolUse } from "./hooks.ts";

/** 作業トークンを差し替えて呼び直す時に、今の呼び出しを止める理由 */
class TicketRenewed extends Error {
  override name = "TicketRenewed";
}

/** 作業トークンを差し替えて続きから呼び直す時の指示。最初の指示を繰り返さない */
export const CONTINUE_PROMPT = "作業トークンを差し替えたので呼び直した。前のチェックポイントの続きから進める";

/** フックの依り所のうち、作業トークンのほか */
type HookBase = Omit<HookDeps, "token">;

/** フックの初期の依り所。ゲートウェイを fetch で呼び、断った記録はログに残す */
const DEFAULT_HOOK: HookBase = {
  fetcher: (url, init) => fetch(url, init),
  clock: systemClock,
  record: (call) => log("warn", "hook_denied", call),
};

/** 今のタスク */
type Current = {
  input: RunInput;
  ticket: string;
  sessionId: string | undefined;
  controller: AbortController;
  renewPending: boolean;
};

/** タスク 1 件分の SDK の呼び出しを持つ。1 度に 1 件だけ */
export class Runner {
  #current: Current | undefined;
  // コンテナの Node は型を外すだけで走らせるので、引数のプロパティを使わない
  readonly #agent: Agent;
  readonly #onFailure: (error: unknown) => void;
  readonly #hookBase: HookBase;

  /**
   * @param agent SDK を 1 回呼ぶ関数
   * @param onFailure SDK の呼び出しが失敗した時に知らせる先
   * @param hookBase フックの依り所。省くとゲートウェイを fetch で呼ぶ
   */
  constructor(agent: Agent, onFailure: (error: unknown) => void, hookBase: HookBase = DEFAULT_HOOK) {
    this.#agent = agent;
    this.#onFailure = onFailure;
    this.#hookBase = hookBase;
  }

  /**
   * 走っているか
   * @returns 走っていれば true
   */
  get running(): boolean {
    return this.#current !== undefined;
  }

  /**
   * 今の作業トークンを返す。フックは毎回これを読む
   * @returns 作業トークン。走っていなければ空
   */
  token(): string {
    return this.#current?.ticket ?? "";
  }

  /**
   * タスクを始める。待たずに返る
   * @param input RunInput
   * @throws conflict もう走っている時
   */
  start(input: RunInput): void {
    if (this.#current) throw new AppError("conflict", "実行中の処理がある");
    const current: Current = { input, ticket: input.ticket, sessionId: input.resume, controller: new AbortController(), renewPending: false };
    this.#current = current;
    void this.#loop(current);
  }

  /**
   * 作業トークンを差し替える。session が分かっていれば今の呼び出しを止めて続きから呼び直し、分かる前なら分かった所で呼び直す
   * @param ticket 新しい作業トークン
   */
  replaceTicket(ticket: string): void {
    const current = this.#current;
    if (!current) return;
    current.ticket = ticket;
    current.renewPending = true;
    if (current.sessionId !== undefined) current.controller.abort(new TicketRenewed("作業トークンを差し替えた"));
  }

  /**
   * SDK を呼び、作業トークンの差し替えで止まったら新しい作業トークンで続きから呼び直す
   * @param current 今のタスク
   */
  async #loop(current: Current): Promise<void> {
    let prompt = current.input.prompt;
    try {
      for (;;) {
        current.renewPending = false;
        const controller = current.controller;
        const hook = preToolUse({ ...this.#hookBase, token: () => this.token() });
        try {
          await this.#agent({
            prompt,
            options: agentOptions({ ...current.input, ticket: current.ticket, hook, abortController: controller, resume: current.sessionId }),
            onSession: (sessionId) => {
              current.sessionId = sessionId;
              if (current.renewPending && !controller.signal.aborted) controller.abort(new TicketRenewed("作業トークンを差し替えた"));
            },
          });
          return;
        } catch (error) {
          if (!(controller.signal.reason instanceof TicketRenewed)) throw error;
          current.controller = new AbortController();
          prompt = CONTINUE_PROMPT;
        }
      }
    } catch (error) {
      this.#onFailure(error);
    } finally {
      this.#current = undefined;
    }
  }
}
