// 社員 DO。社員 1 人の勤務の時刻と勤怠を持つ。判断は StaffBook に置き、ここは alarm と記憶を包むだけ (社員と勤怠の 1.3)
import { DurableObject } from "cloudflare:workers";
import { AppError, StaffId, type StaffStatus, systemClock } from "@know-office/core";
import type { Bindings, Staff } from "../env.ts";
import type { Observed } from "../guard/deps.ts";
import { StaffGuard, type TicketCheck } from "../guard/staff-guard.ts";
import { StaffBook, type Workspace } from "../work/staff-book.ts";

// ワークスペースのコンテナはまだ無い (tasks.md の 7.2 でつなぐ)。それまでは何もしない代わりを渡し、勤怠だけを付ける
const IDLE_WORKSPACE: Workspace = {
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  wrapUp: () => Promise.resolve(),
  restart: () => Promise.resolve(),
};

/** 社員 DO。`idFromName(<社員 ID>)` で社員 1 人に 1 つ。ゲートウェイだけが RPC で呼び、時刻は呼ぶ側の Clock で渡す */
export class StaffDO extends DurableObject<Bindings> implements Staff {
  #book: StaffBook | undefined;
  #guard: StaffGuard | undefined;
  /** 操作を 1 つずつ流す鎖。前の操作が断られても次へ進む */
  #chain: Promise<unknown> = Promise.resolve();

  /**
   * 次の出来事を処理し、次の alarm を掛ける。alarm は本物の時刻で鳴る
   * @returns 無し
   */
  override async alarm(): Promise<void> {
    await this.wake(systemClock.now());
  }

  /**
   * その時刻までに来た出来事を処理する。alarm と、テストの時計から呼ぶ
   * @param now 今の時刻
   * @returns 無し
   */
  wake(now: number): Promise<null> {
    return this.#run((book) => book.wake(now));
  }

  /**
   * 今の状態を返す
   * @param now 今の時刻
   * @returns 状態、今のタスク、今日の働いた時間
   */
  status(now: number): Promise<StaffStatus> {
    return this.#serial((book) => book.status(now));
  }

  /**
   * ワークスペースのハートビートを受ける
   * @param at 受けた時刻
   * @returns 無し
   */
  heartbeat(at: number): Promise<null> {
    return this.#run((book) => book.heartbeat(at));
  }

  /**
   * チェックポイントを受ける
   * @param input CheckpointInput
   * @param now 今の時刻
   * @returns 無し
   * @throws conflict 今のタスクと違う時
   */
  checkpoint(input: unknown, now: number): Promise<null> {
    return this.#run((book) => book.checkpoint(input, now));
  }

  /**
   * 新しいタスクを取るかを決め、取ればそのタスクを持つ
   * @param task StaffTask
   * @param medianMs 同じ種類のタスクがチェックポイントに届くまでの直前 7 日の中央値。無ければ null
   * @param now 今の時刻
   * @returns 取ったか
   */
  take(task: unknown, medianMs: number | null, now: number): Promise<{ taken: boolean }> {
    return this.#serial((book) => book.take(task, medianMs, now));
  }

  /**
   * 今のタスクを離れる
   * @param result WorkResult
   * @param now 今の時刻
   * @returns 無し
   */
  finish(result: unknown, now: number): Promise<null> {
    return this.#run((book) => book.finish(result, now));
  }

  /**
   * その日だけの指示を受け、今日の予定を作り直す。指示は先に day_orders に足しておく
   * @param order day_orders の行
   * @param now 今の時刻
   * @returns 無し
   */
  order(order: unknown, now: number): Promise<null> {
    return this.#run((book) => book.order(order, now));
  }

  /**
   * 時間外に呼び出す
   * @param task StaffTask
   * @param now 今の時刻
   * @returns 無し
   */
  call(task: unknown, now: number): Promise<null> {
    return this.#run((book) => book.call(task, now));
  }

  /**
   * API の上限で待ち始める。Claude のプロキシが呼ぶ
   * @param reason rate_limit
   * @param now 今の時刻
   * @returns 無し
   */
  waitStart(reason: unknown, now: number): Promise<null> {
    return this.#run((book) => book.waitStart(reason, now));
  }

  /**
   * API の上限の待ちを解く
   * @param now 今の時刻
   * @returns 無し
   */
  waitEnd(now: number): Promise<null> {
    return this.#run((book) => book.waitEnd(now));
  }

  /**
   * 自動停止で止める
   * @param now 今の時刻
   * @returns 無し
   */
  stop(now: number): Promise<null> {
    return this.#run((book) => book.stop(now));
  }

  /**
   * 止めていたのを再開する
   * @param now 今の時刻
   * @returns 無し
   */
  resume(now: number): Promise<null> {
    return this.#run((book) => book.resume(now));
  }

  /**
   * 勤怠の行を訂正する。勤怠を書くほかの操作と同じ鎖で流す
   * @param originalId 訂正する行の ID
   * @param input CorrectionValues
   * @param now 今の時刻
   * @returns 足した行の ID
   * @throws not_found この社員の行が無い時
   * @throws conflict もう訂正された行か、区分が重なる時
   */
  correct(originalId: string, input: unknown, now: number): Promise<{ id: string }> {
    return this.#serial((book) => book.correct(originalId, input, now));
  }

  /**
   * 社員とタスクの出来事を数える。ゲートウェイだけが呼び、社員からは読めない
   * @param event GuardEvent
   * @param now 今の時刻
   * @param thresholds 今の基準
   * @returns 答えと直前の出来事
   * @throws validation_failed 形が違うか、ほかの社員の出来事の時
   */
  observe(event: unknown, now: number, thresholds: unknown): Promise<Observed> {
    return this.#serial(() => this.#guardOf().then((g) => g.observe(event, now, thresholds)));
  }

  /**
   * 止めたタスクを離れ、その作業トークンを失効させ、タスクの数を消す
   * @param nodeId タスク ID
   * @param now 今の時刻
   * @returns 無し
   */
  dropTask(nodeId: string, now: number): Promise<null> {
    return this.#serial(() => this.#guardOf().then((g) => g.dropTask(nodeId, now)));
  }

  /**
   * 社員を止め、作業トークンをすべて失効させ、ワークスペースを作り直す
   * @param now 今の時刻
   * @returns 無し
   */
  halt(now: number): Promise<null> {
    return this.#serial(() => this.#guardOf().then((g) => g.halt(now)));
  }

  /**
   * 再開したタスクの数を 0 に戻す
   * @param nodeId タスク ID
   * @returns 無し
   */
  resumeTask(nodeId: string): Promise<null> {
    return this.#serial(() => this.#guardOf().then((g) => g.resumeTask(nodeId)));
  }

  /**
   * 今のタスクの働いた時間を返す
   * @param now 今の時刻
   * @returns タスク ID と働いた時間。無ければ null
   */
  taskClock(now: number): Promise<{ nodeId: string; activeMs: number } | null> {
    return this.#serial((book) => book.taskClock(now));
  }

  /**
   * タスクの作業トークンを発行する
   * @param nodeId タスク ID
   * @param workspaceId 渡すワークスペースの ID
   * @param now 今の時刻
   * @returns 作業トークン ID
   */
  issueToken(nodeId: string, workspaceId: string, now: number): Promise<{ jti: string }> {
    return this.#serial(() => this.#guardOf().then((g) => g.issueToken(nodeId, workspaceId, now)));
  }

  /**
   * 作業トークンが使えるかを確かめる
   * @param jti 作業トークン ID
   * @param workspaceId 使ったワークスペースの ID
   * @param now 今の時刻
   * @returns ok、失効した、期限切れ、発行した先と違う
   */
  checkToken(jti: string, workspaceId: string, now: number): Promise<TicketCheck> {
    return this.#serial(() => this.#guardOf().then((g) => g.checkToken(jti, workspaceId, now)));
  }

  /**
   * 数え方の本を作る。勤務の本と同じ記憶を使う
   * @returns StaffGuard
   */
  async #guardOf(): Promise<StaffGuard> {
    const book = await this.#open();
    this.#guard ??= new StaffGuard(book.staffId, this.ctx.storage, this.env.DB, book);
    return this.#guard;
  }

  /**
   * 1 日の集計を作り直す。毎日 0 時 5 分の定期ジョブが呼ぶ
   * @param day 日本時間の日
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 日の形が違う時
   */
  rebuildDay(day: unknown, now: number): Promise<null> {
    return this.#run((book) => book.rebuildDay(day, now));
  }

  /**
   * 記憶を変える操作を流し、何も返さない
   * @param step StaffBook の操作
   * @returns 無し
   */
  async #run(step: (book: StaffBook) => Promise<void>): Promise<null> {
    await this.#serial(step);
    return null;
  }

  /**
   * 操作を 1 つずつ順に流す。D1 を待つ間に alarm やほかの呼び出しが割り込むと、開いている区分が割れる
   * blockConcurrencyWhile の中で投げると DO が作り直されるので使わない。断られた操作は鎖の外で投げ、鎖は次へ進める
   * @param step StaffBook の操作
   * @returns 操作の答え
   */
  async #serial<T>(step: (book: StaffBook) => Promise<T>): Promise<T> {
    const settled = this.#chain.then(async () => {
      try {
        return { ok: true as const, value: await step(await this.#open()) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    this.#chain = settled;
    const result = await settled;
    if (result.ok) return result.value;
    throw result.error;
  }

  /**
   * 社員 ID を確かめて StaffBook を作る。社員 ID は idFromName の名前で、alarm で起きた時のために記憶にも置く
   * @returns StaffBook
   * @throws internal 社員 ID が分からない時
   */
  async #open(): Promise<StaffBook> {
    if (this.#book) return this.#book;
    const named = this.ctx.id.name;
    if (named !== undefined) await this.ctx.storage.put("staffId", named);
    const parsed = StaffId.safeParse(named ?? (await this.ctx.storage.get("staffId")));
    if (!parsed.success) throw new AppError("internal", "社員 DO の社員 ID が分からない");
    this.#book = new StaffBook(parsed.data, this.ctx.storage, this.env.DB, IDLE_WORKSPACE);
    return this.#book;
  }
}
