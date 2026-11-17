// タスク 1 件分の SDK の呼び出しを持ち、作業トークンが差し替わったら今の呼び出しを終えて続きから呼び直す。呼び直す前と終わった時に会話の記録の増えを送る (社員が考えるの 3.3、3.7)
import { type AgentEvent, AppError, log, type OwnerMessage, ownerMessagesPrompt, type RestoreInput, type RunInput, systemClock } from "@know-office/core";
import { type Agent, agentOptions, type LocalRun } from "./agent.ts";
import { type HookDeps, preToolUse } from "./hooks.ts";
import { SdkFailure } from "./sdk.ts";
import { staffServer } from "./staff-tools.ts";

/** 今の呼び出しを止める理由。ticket は作業トークンの差し替え、message はオーナーの発言、abort は中断。どれもゲートウェイには失敗として伝えない */
class Interrupt extends Error {
  override name = "Interrupt";
  /** 止めた訳 */
  readonly kind: "ticket" | "message" | "abort";

  /**
   * 止める理由を作る。コンテナは Node の型を外すだけの読み込みで動くので、引数のプロパティを使わない
   * @param kind 止めた訳
   */
  constructor(kind: "ticket" | "message" | "abort") {
    super(`${kind} で止めた`);
    this.kind = kind;
  }
}

/** 作業トークンを差し替えて続きから呼び直す時の指示。最初の指示を繰り返さない */
export const CONTINUE_PROMPT = "作業トークンを差し替えたので呼び直した。前のチェックポイントの続きから進める";

/**
 * オーナーの発言を足して続きから呼ぶ時の指示を作る。発言の書式は次のタスクの頭に足す物と同じ
 * @param messages 届いた順の発言
 * @returns 指示
 */
export function messagePrompt(messages: readonly OwnerMessage[]): string {
  return `オーナーから発言が届いたので、呼び出しを止めて続きから呼び直した。発言を読み、今のタスクの続きに生かす。\n\n${ownerMessagesPrompt(messages)}`;
}

/** ゲートウェイに働いた事を届ける口。本物は events.ts の gateReporter */
export type Reporter = {
  /** 出来事を作業トークンを付けて送る。ticket は送る時の今の作業トークンを返す。送れなくても投げない */
  report(ticket: () => string, events: AgentEvent[]): Promise<void>;
};

/** 届けない口 */
const NO_REPORTER: Reporter = { report: () => Promise.resolve() };

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
  /** session が分かったら今の呼び出しを止める訳。分かる前に差し替えか発言が来た時に置く */
  pending: "ticket" | "message" | null;
  /** まだ指示に入れていないオーナーの発言 */
  messages: OwnerMessage[];
  /** 中断を頼まれたか */
  aborting: boolean;
  /** 呼び出しが終わった時に解ける */
  done: Promise<void>;
  /** done を解く */
  settle: () => void;
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
  readonly #reporter: Reporter;
  /** 走りを空けた後に、終わりかエラーを送っているタスク */
  #reporting: Current | undefined;
  readonly #local: LocalRun | undefined;

  /**
   * タスクを持つ入れ物を、SDK を呼ぶ関数と失敗の知らせ先と一緒に作る
   * @param agent SDK を 1 回呼ぶ関数
   * @param onFailure SDK の呼び出しが失敗した時に知らせる先
   * @param hookBase フックの依り所。省くとゲートウェイを fetch で呼ぶ
   * @param transcripts 会話の記録を送り、戻す口。省くと送らない。本番は main.ts が TranscriptShipper を渡す
   * @param reporter 働いた事をゲートウェイに届ける口。省くと届けない。本番は main.ts が gateReporter を渡す
   * @param local SDK の Claude の宛先と手元の置き場。開発の代わりのワークスペースだけが渡し、本番は省いて宛先と置き場を変えない
   */
  constructor(agent: Agent, onFailure: (error: unknown) => void, hookBase: HookBase = DEFAULT_HOOK, transcripts: Transcripts = NO_TRANSCRIPTS, reporter: Reporter = NO_REPORTER, local?: LocalRun) {
    this.#agent = agent;
    this.#onFailure = onFailure;
    this.#hookBase = hookBase;
    this.#transcripts = transcripts;
    this.#reporter = reporter;
    this.#local = local;
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
    const current: Current = {
      input,
      ticket: input.ticket,
      sessionId: input.resume,
      controller: new AbortController(),
      pending: null,
      messages: [],
      aborting: false,
      done: Promise.resolve(),
      settle: () => {},
      flushedAt: this.#hookBase.clock.now(),
      flushing: false,
    };
    current.done = new Promise((resolve) => {
      current.settle = resolve;
    });
    this.#current = current;
    void this.#loop(current);
  }

  /**
   * 作業トークンを差し替える。session が分かっていれば今の呼び出しを止めて続きから呼び直し、分かる前なら分かった所で呼び直す
   * @param ticket 新しい作業トークン
   */
  replaceTicket(ticket: string): void {
    const current = this.#current;
    if (!current) {
      // 走りを空けた後、終わりを送っている間に届いた物も、送り直しに使えるよう渡す
      if (this.#reporting) this.#reporting.ticket = ticket;
      return;
    }
    current.ticket = ticket;
    this.#interrupt(current, "ticket");
  }

  /**
   * 走っている呼び出しにオーナーの発言を足す。送っていない記録を送ってから今の呼び出しを止め、発言を指示に続きから呼ぶ
   * 止めている途中に届いた発言は、同じ続きにまとめる
   * @param message 発言と、ゲートウェイが受けた時刻
   * @returns 止めるのを頼んだ所
   * @throws conflict 走っていない時か、中断している時
   */
  async addMessage(message: OwnerMessage): Promise<void> {
    const current = this.#current;
    if (!current || current.aborting) throw new AppError("conflict", "実行中の処理がない");
    const first = current.messages.length === 0 && current.pending === null;
    current.messages.push(message);
    // 2 つ目からは、1 つ目が頼んだ続きにまとめる
    if (!first) return;
    current.pending = "message";
    await this.#flush(current);
    this.#interrupt(current, "message");
  }

  /**
   * 走っている呼び出しを止め、送っていない会話の記録を送り終えるまで待つ。終わりもエラーもゲートウェイに送らない
   * @param reason 止める訳。ログに残す
   * @returns 止め終わり
   */
  async abort(reason: string): Promise<void> {
    const current = this.#current;
    if (!current) return;
    log("info", "run_aborted", { reason: reason.slice(0, 200) });
    current.aborting = true;
    if (!current.controller.signal.aborted) current.controller.abort(new Interrupt("abort"));
    await current.done;
  }

  /**
   * 今の呼び出しを止めるのを頼む。session が分かる前なら、分かった所で止める
   * @param current 今のタスク
   * @param kind 止める訳
   */
  #interrupt(current: Current, kind: "ticket" | "message"): void {
    current.pending = kind;
    if (current.sessionId !== undefined && !current.controller.signal.aborted) current.controller.abort(new Interrupt(kind));
  }

  /**
   * 次の指示を決める。届いた発言があれば発言を、無ければ作業トークンの差し替えの続きを指示にする
   * @param current 今のタスク
   * @returns 指示
   */
  #nextPrompt(current: Current): string {
    if (current.messages.length > 0) return messagePrompt(current.messages.splice(0));
    return CONTINUE_PROMPT;
  }

  /**
   * SDK を呼び、作業トークンの差し替えか発言で止まったら続きから呼び直す。終われば走りを空けてから、終わりか失敗をゲートウェイに送る
   * @param current 今のタスク
   */
  async #loop(current: Current): Promise<void> {
    let prompt = current.input.prompt;
    try {
      for (;;) {
        current.pending = null;
        const controller = current.controller;
        const hook = preToolUse({ ...this.#hookBase, token: () => this.token() });
        // MCP の受け手は SDK の呼び出しごとに作る。作業トークンはツールを呼ぶたびに今の物を読み、チェックポイントの後に記録を送る
        const staff = staffServer({ fetcher: this.#hookBase.fetcher, token: () => this.token(), onCheckpoint: () => void this.#flush(current) }, current.input.tools, current.input.extensionTools);
        let text: string | undefined | void;
        try {
          text = await this.#agent({
            prompt,
            options: agentOptions({ ...current.input, ticket: current.ticket, hook, staff, abortController: controller, resume: current.sessionId, local: this.#local }),
            onSession: (sessionId) => {
              current.sessionId = sessionId;
              const kind = current.pending;
              if (kind !== null && !controller.signal.aborted) controller.abort(new Interrupt(kind));
            },
            onEvent: () => this.#flushEvery(current),
          });
        } catch (error) {
          // 落ちても、そこまでの記録は残す
          await this.#flush(current);
          const reason: unknown = controller.signal.reason;
          if (current.aborting) return;
          if (!(reason instanceof Interrupt)) throw error;
          current.controller = new AbortController();
          prompt = this.#nextPrompt(current);
          continue;
        }
        await this.#flush(current);
        // SDK が終えた後に止めが届いても、終わりは決まっているので done を送る。終わる間際に届いた発言は、止めていなければ捨てずに続きを呼ぶ
        if (!current.aborting && current.messages.length > 0) {
          current.controller = new AbortController();
          prompt = this.#nextPrompt(current);
          continue;
        }
        this.#release(current);
        const said: AgentEvent[] = text ? [{ kind: "message", body: text.slice(0, 20_000) }] : [];
        await this.#report(current, [...said, { kind: "result", nodeId: current.input.nodeId, result: "done" }]);
        return;
      }
    } catch (error) {
      this.#release(current);
      this.#onFailure(error);
      // SDK の文は鍵を含みうるので、自分で付けた種類と文だけを送る
      const failure = error instanceof SdkFailure ? { name: error.name, message: error.message.slice(0, 200) } : { name: "sdk_failed" as const, message: "SDK の呼び出しが失敗した" };
      await this.#report(current, [
        { kind: "error", ...failure },
        { kind: "result", nodeId: current.input.nodeId, result: "handed_back" },
      ]);
    } finally {
      this.#release(current);
      current.settle();
    }
  }

  /**
   * 走りを空けた後に、終わりかエラーを今の作業トークンで送る。送っている間に差し替わった作業トークンも使う
   * @param current 今のタスク
   * @param events 出来事
   */
  async #report(current: Current, events: AgentEvent[]): Promise<void> {
    this.#reporting = current;
    try {
      await this.#reporter.report(() => current.ticket, events);
    } finally {
      if (this.#reporting === current) this.#reporting = undefined;
    }
  }

  /**
   * 走りを空ける。次のタスクを受けられるよう、ゲートウェイに終わりを送る前に呼ぶ
   * @param current 今のタスク
   */
  #release(current: Current): void {
    if (this.#current === current) this.#current = undefined;
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
