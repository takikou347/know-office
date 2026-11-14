// タスク 1 件分の SDK の呼び出しを持ち、作業トークンが差し替わったら今の呼び出しを終えて続きから呼び直す。呼び直す前と終わった時に会話の記録の増えを送る (社員が考えるの 3.2、3.6)
import { AppError, log, type RestoreInput, type RunInput, systemClock } from "@know-office/core";
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

/** 会話の記録を送り、戻す口。本物は transcript.ts の TranscriptShipper */
export type Transcripts = {
  /** session の記録の増えを、作業トークンを付けて送る */
  flush(sessionId: string, ticket: string): Promise<void>;
  /** 復号した記録を SDK の置き場に書く */
  restore(input: RestoreInput): Promise<void>;
};

/** SDK の出来事を読む間に会話の記録を送る間 (60 秒)。落ちても失うのはこの間の分だけにする */
const FLUSH_EVERY_MS = 60_000;

/** 会話の記録を送らない口 */
const NO_TRANSCRIPTS: Transcripts = { flush: () => Promise.resolve(), restore: () => Promise.resolve() };

/** 今のタスク */
type Current = {
  input: RunInput;
  ticket: string;
  sessionId: string | undefined;
  controller: AbortController;
  renewPending: boolean;
  /** 前に会話の記録を送り始めた時刻 */
  flushedAt: number;
  /** 会話の記録を送っている途中か */
  flushing: boolean;
};

/** タスク 1 件分の SDK の呼び出しを持つ。1 度に 1 件だけ */
export class Runner {
  #current: Current | undefined;
  // コンテナの Node は型を外すだけで走らせるので、引数のプロパティを使わない
  readonly #agent: Agent;
  readonly #onFailure: (error: unknown) => void;
  readonly #hookBase: HookBase;
  readonly #transcripts: Transcripts;

  /**
   * タスクを持つ入れ物を、SDK を呼ぶ関数と失敗の知らせ先と一緒に作る
   * @param agent SDK を 1 回呼ぶ関数
   * @param onFailure SDK の呼び出しが失敗した時に知らせる先
   * @param hookBase フックの依り所。省くとゲートウェイを fetch で呼ぶ
   * @param transcripts 会話の記録を送り、戻す口。省くと送らない。本番は main.ts が TranscriptShipper を渡す
   */
  constructor(agent: Agent, onFailure: (error: unknown) => void, hookBase: HookBase = DEFAULT_HOOK, transcripts: Transcripts = NO_TRANSCRIPTS) {
    this.#agent = agent;
    this.#onFailure = onFailure;
    this.#hookBase = hookBase;
    this.#transcripts = transcripts;
  }

  /**
   * 社員 DO が復号した会話の記録を SDK の置き場に戻す。続きは後の start() で resume を付けて呼ぶ
   * @param input RestoreInput
   * @returns 書き終わり
   * @throws conflict 走っている時
   */
  async restore(input: RestoreInput): Promise<void> {
    if (this.#current) throw new AppError("conflict", "実行中の処理がある");
    await this.#transcripts.restore(input);
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
    const current: Current = { input, ticket: input.ticket, sessionId: input.resume, controller: new AbortController(), renewPending: false, flushedAt: this.#hookBase.clock.now(), flushing: false };
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
            onEvent: () => this.#flushEvery(current),
          });
          await this.#flush(current);
          return;
        } catch (error) {
          // 落ちても、そこまでの記録は残す
          await this.#flush(current);
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

  /**
   * SDK の出来事を読む間、前に送り始めてから 60 秒過ぎていれば会話の記録の増えを送る。呼び出しを止めないよう待たず、送っている途中なら重ねない
   * @param current 今のタスク
   */
  #flushEvery(current: Current): void {
    if (current.flushing || this.#hookBase.clock.now() - current.flushedAt < FLUSH_EVERY_MS) return;
    void this.#flush(current);
  }

  /**
   * 会話の記録の増えを、その時の作業トークンで送る。送れなくても呼び出しは止めず、次に同じ所から送り直す
   * @param current 今のタスク
   */
  async #flush(current: Current): Promise<void> {
    if (current.sessionId === undefined) return;
    current.flushing = true;
    current.flushedAt = this.#hookBase.clock.now();
    try {
      await this.#transcripts.flush(current.sessionId, current.ticket);
    } catch (error) {
      log("warn", "transcript_send_failed", { error: error instanceof Error ? error.message : "unknown" });
    } finally {
      current.flushing = false;
    }
  }
}
