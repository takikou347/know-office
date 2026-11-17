// 社員 DO。社員 1 人の勤務の時刻と勤怠を持つ。判断は StaffBook に置き、ここは alarm と記憶を包むだけ (社員と勤怠の 2 章)
import { DurableObject } from "cloudflare:workers";
import { AppError, log, type RestoreInput, StaffId, type StaffStatus, systemClock } from "@know-office/core";
import { z } from "zod";
import type { DurableObjectStub } from "@cloudflare/workers-types";
import type { Bindings, Staff, WorkspaceContainer } from "../env.ts";
import type { Observed } from "../guard/deps.ts";
import { type IssuedTicket, type RenewedTicket, StaffGuard, type TicketCheck } from "../guard/staff-guard.ts";
import { type Pulled, pullNext, wasCarried } from "../work/loop.ts";
import { announce, announceNotice } from "../live/publish.ts";
import { appendNodeEvent } from "../work/nodes.ts";
import { StaffBook, type Workspace } from "../work/staff-book.ts";
import { startRun } from "../work/run.ts";
import { appendTranscript, continueRun, loadTranscript, type TranscriptStore } from "../work/transcript.ts";

/** 今のタスクの呼び出しの様子。started は runs が受け付けられた、failures は続けて失敗した回数 */
const RunMarks = z.record(z.string(), z.object({ started: z.boolean(), failures: z.number().int().nonnegative() }).strict());

/** 社員 DO。`idFromName(<社員 ID>)` で社員 1 人に 1 つ。ゲートウェイだけが RPC で呼び、時刻は呼ぶ側の Clock で渡す */
export class StaffDO extends DurableObject<Bindings> implements Staff {
  #book: StaffBook | undefined;
  #guard: StaffGuard | undefined;
  /** 操作を 1 つずつ流す鎖。前の操作が断られても次へ進む */
  #chain: Promise<unknown> = Promise.resolve();
  // 前に画面に配った「状態/今のタスク」。起き直した後は null から始め、1 回目は必ず配る
  #published: string | null = null;
  /** ワークスペースへの頼み (起こす、止める、書き残させる、作り直す) を順に流す鎖。書き残させる前に止めない */
  #workspaceChain: Promise<unknown> = Promise.resolve();

  /**
   * 次の出来事を処理し、次の alarm を掛ける。alarm は本物の時刻で鳴る
   * @returns 無し
   */
  override async alarm(): Promise<void> {
    const now = systemClock.now();
    await this.wake(now);
    await this.pull(now);
  }

  /**
   * その時刻までに来た出来事を処理する。alarm と、テストの時計から呼ぶ
   * @param now 今の時刻
   * @returns 無し
   */
  wake(now: number): Promise<null> {
    return this.#run((book) => book.wake(now), now);
  }

  /**
   * 始まりの時刻を処理し終えた日の印を消して出来事を処理する。開発の道 (/__dev/staff/<社員 ID>/forget-day) だけが呼ぶ
   * @param now 今の時刻
   * @returns 無し
   */
  forgetDay(now: number): Promise<null> {
    return this.#run((book) => book.forgetDay(now), now);
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
    return this.#run((book) => book.heartbeat(at), at);
  }

  /**
   * チェックポイントを受ける
   * @param input CheckpointInput
   * @param now 今の時刻
   * @returns 無し
   * @throws conflict 今のタスクと違う時
   */
  checkpoint(input: unknown, now: number): Promise<null> {
    return this.#run((book) => book.checkpoint(input, now), now);
  }

  /**
   * 新しいタスクを取るかを決め、取ればそのタスクを持つ
   * @param task StaffTask
   * @param medianMs 同じ種類のタスクがチェックポイントに届くまでの直前 7 日の中央値。無ければ null
   * @param now 今の時刻
   * @returns 取ったか
   */
  take(task: unknown, medianMs: number | null, now: number): Promise<{ taken: boolean }> {
    return this.#serial((book) => book.take(task, medianMs, now), now);
  }

  /**
   * 今のタスクを離れる
   * @param result WorkResult
   * @param now 今の時刻
   * @returns 無し
   */
  finish(result: unknown, now: number): Promise<null> {
    return this.#run((book) => book.finish(result, now), now);
  }

  /**
   * 勤務中で手が空いていれば、自分の山から優先度の順に次のタスクを取る。山が空なら上司に次を求める
   * @param now 今の時刻
   * @param traceId 取らせた要求の traceId。呼び出しの作業トークンが持ち、ワークスペースの要求を同じ流れで追える
   * @returns 取ったか。nodeId は取ったか、もう持っていたタスク
   */
  async pull(now: number, traceId?: string): Promise<Pulled> {
    const { carried, ...pulled } = await this.#serial((book) => pullNext(this.env, book, now), now);
    // 呼び出しは鎖の外で始める。作業トークンの発行がこの DO の鎖を通るので、鎖の中で待つと止まる。前の勤務で続きにしたタスクは、最後の会話の記録から続ける
    if (pulled.taken) this.#begin(carried ? "continue" : "start", now, traceId);
    return pulled;
  }

  /**
   * 次の alarm が掛かっていなければ wake で掛ける。持っているタスクの呼び出しが始まっていなければ始める。5 分ごとの定期ジョブが呼ぶ
   * 新しい社員 DO は、誰かが呼ぶまで alarm を持たないので、9 時に出勤しない
   * @param now 今の時刻
   * @returns 掛かっている alarm の時刻。無ければ null
   */
  async arm(now: number): Promise<{ alarm: number | null }> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.wake(now);
    const { id, state, nodeId } = await this.status(now);
    // 補完で起こしたワークスペースの期限を、alarm が消えた時の予備として確かめる。落ちても勤務は止めない
    await this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(id))
      .sweepEditor(now)
      .catch((error: unknown) => log("warn", "editor_sweep_failed", { staffId: id, error: error instanceof Error ? error.message : "unknown" }));
    // pull でタスクを doing にした後、呼び出しを始める前に DO が落ちると、誰も始めない。ここで見つけて始める
    if (nodeId !== null && (state === "working" || state === "called") && !(await this.runState(nodeId)).started) this.#begin("continue", now);
    return { alarm: await this.ctx.storage.getAlarm() };
  }

  /**
   * 今のタスクの呼び出しの様子を返す
   * @param nodeId タスク ID
   * @returns 始めた時の役目の説明文の版、受け付けられたか、続けて失敗した回数
   */
  runState(nodeId: string): Promise<{ promptVersion: number | null; started: boolean; failures: number }> {
    return this.#serial(async (book) => {
      const mark = (await this.#marks())[nodeId];
      return { promptVersion: await book.promptVersionOf(nodeId), started: mark?.started ?? false, failures: mark?.failures ?? 0 };
    });
  }

  /**
   * 呼び出しの様子を書く。started は受け付けられた、failed は失敗を 1 つ数える、done は数えを消す
   * @param nodeId タスク ID
   * @param mark 書く様子
   * @returns 数えた後の失敗の回数
   */
  markRun(nodeId: string, mark: "started" | "failed" | "done"): Promise<{ failures: number }> {
    return this.#serial(async () => {
      const marks = await this.#marks();
      const was = marks[nodeId] ?? { started: false, failures: 0 };
      if (mark === "done") delete marks[nodeId];
      else marks[nodeId] = mark === "started" ? { ...was, started: true } : { started: false, failures: was.failures + 1 };
      await this.ctx.storage.put("runs", marks);
      return { failures: marks[nodeId]?.failures ?? 0 };
    });
  }

  /**
   * 記憶の呼び出しの様子を読む
   * @returns タスクごとの様子
   */
  async #marks(): Promise<z.infer<typeof RunMarks>> {
    return RunMarks.parse((await this.ctx.storage.get("runs")) ?? {});
  }

  /**
   * 持っているタスクの呼び出しを、待たずに始める。失敗は log に残し、次の arm がもう一度見る
   * @param how start は最初から、continue は記録があれば続きから
   * @param now 今の時刻
   * @param traceId 呼び出しを始めさせた要求の traceId。無ければ作業トークンを出す時に新しく作る
   */
  #begin(how: "start" | "continue", now: number, traceId?: string): void {
    void this.#open()
      .then((book) => (how === "start" ? startRun(this.env, book.staffId, now, traceId) : continueRun(this.env, book.staffId, now)))
      .catch((error: unknown) => log("error", "run_begin_failed", { how, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
  }

  /**
   * その日だけの指示を受け、今日の予定を作り直す。指示は先に day_orders に足しておく
   * @param order day_orders の行
   * @param now 今の時刻
   * @returns 無し
   */
  order(order: unknown, now: number): Promise<null> {
    return this.#run((book) => book.order(order, now), now);
  }

  /**
   * 時間外に呼び出す
   * @param task StaffTask
   * @param now 今の時刻
   * @param traceId 呼び出した要求の traceId
   * @param limit 話しかけた時の 1 日の回数の上限。タスクを頼んだ時は渡さない
   * @param limit.perDay 1 日の回数
   * @returns 呼び出したか。false の時はタスクを渡していないので、呼んだ側が todo に戻す
   */
  async call(task: unknown, now: number, traceId?: string, limit?: { perDay: number }): Promise<boolean> {
    const called = await this.#serial((book) => book.call(task, now, limit), now);
    if (!called) return false;
    // 出勤を書いた後は true を返す。ここで投げると呼んだ側がタスクを todo に戻し、記憶の持つタスクと食い違う
    this.#begin((await this.#carried(now)) ? "continue" : "start", now, traceId);
    return true;
  }

  /**
   * 持っているタスクが前の勤務で続きにしたタスクかを見る。読めなければ最初からの呼び出しにし、ログに残す
   * @param now 今の時刻
   * @returns 続きのタスクなら true
   */
  async #carried(now: number): Promise<boolean> {
    try {
      const { nodeId } = await this.status(now);
      return nodeId !== null && (await wasCarried(this.env, (await this.#open()).staffId, nodeId));
    } catch (error) {
      log("warn", "call_carried_read_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return false;
    }
  }

  /**
   * API の上限で待ち始める。Claude のプロキシが呼ぶ
   * @param reason rate_limit
   * @param now 今の時刻
   * @returns 無し
   */
  waitStart(reason: unknown, now: number): Promise<null> {
    return this.#run((book) => book.waitStart(reason, now), now);
  }

  /**
   * API の上限の待ちを解く
   * @param now 今の時刻
   * @returns 待っていた時間。上限で待っていなければ null
   */
  async waitEnd(now: number): Promise<{ waitedMs: number | null }> {
    return { waitedMs: await this.#serial((book) => book.waitEnd(now), now) };
  }

  /**
   * 自動停止で止める
   * @param now 今の時刻
   * @returns 無し
   */
  stop(now: number): Promise<null> {
    return this.#run((book) => book.stop(now), now);
  }

  /**
   * 止めていたのを再開する
   * @param now 今の時刻
   * @returns 無し
   */
  async resume(now: number): Promise<null> {
    await this.#run((book) => book.resume(now), now);
    // 止めた時にワークスペースを作り直しているので、持っているタスクを続きから呼ぶ
    this.#begin("continue", now);
    return null;
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
    return this.#serial(() => this.#guardOf().then((g) => g.dropTask(nodeId, now)), now);
  }

  /**
   * 社員を止め、作業トークンをすべて失効させ、ワークスペースを作り直す
   * @param now 今の時刻
   * @returns 無し
   */
  halt(now: number): Promise<null> {
    return this.#serial(() => this.#guardOf().then((g) => g.halt(now)), now);
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
   * タスクが読んだ外部の文章の出所を返す。ルールの判断が外部の文章の印を見るのに使う
   * @param nodeId タスク ID
   * @returns 読んだ順の出所
   */
  externalSources(nodeId: string): Promise<string[]> {
    return this.#serial(() => this.#guardOf().then((g) => g.externalSources(nodeId)));
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
   * @param traceId 呼び出しを始めた要求の traceId
   * @returns 作業トークン ID と期限と traceId
   */
  issueToken(nodeId: string, workspaceId: string, now: number, traceId: string | null = null): Promise<IssuedTicket> {
    return this.#serial(() => this.#guardOf().then((g) => g.issueToken(nodeId, workspaceId, now, traceId)));
  }

  /**
   * 残りが 10 分を切った作業トークンを発行し直す
   * @param nodeId タスク ID
   * @param workspaceId 渡すワークスペースの ID
   * @param now 今の時刻
   * @returns 新しい作業トークン。要らなければ null
   */
  renewToken(nodeId: string, workspaceId: string, now: number): Promise<RenewedTicket | null> {
    return this.#serial(() => this.#guardOf().then((g) => g.renewToken(nodeId, workspaceId, now)));
  }

  /**
   * 作業トークンを ID で失効させる
   * @param jtis 作業トークン ID
   * @returns 無し
   */
  revokeTokens(jtis: string[]): Promise<null> {
    return this.#serial(() => this.#guardOf().then((g) => g.revokeTokens(jtis)));
  }

  /**
   * タスクの作業トークンを、残す 1 本のほかすべて失効させる
   * @param nodeId タスク ID
   * @param keepJti 残す作業トークン ID
   * @returns 失効させた作業トークン ID
   */
  revokeOthers(nodeId: string, keepJti: string): Promise<string[]> {
    return this.#serial(() => this.#guardOf().then((g) => g.revokeOthers(nodeId, keepJti)));
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
   * 会話の記録の続きを、タスクごとの鍵で暗号にして R2 に置く。同じ session の部分を 1 つずつ足すので、ほかの操作と同じ鎖で流す
   * @param nodeId タスク ID。作業トークンから読む
   * @param input TranscriptPartInput
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 形が違う時
   * @throws conflict 通し番号が前回の続きでない時
   */
  appendTranscript(nodeId: string, input: unknown, now: number): Promise<null> {
    return this.#run((book) => appendTranscript(this.#transcripts(), book.staffId, nodeId, input, now), now);
  }

  /**
   * タスクの最後の session の会話の記録を復号して返す。鍵は社員 DO だけが作る
   * @param nodeId タスク ID
   * @returns session、記録の全部の base64、次の通し番号。記録が無ければ null
   * @throws payload_too_large 記録の全部が上限を超える時
   * @throws internal 部分が欠けているか、戻せない時
   */
  loadTranscript(nodeId: string): Promise<RestoreInput | null> {
    return this.#serial((book) => loadTranscript(this.#transcripts(), book.staffId, nodeId));
  }

  /**
   * 会話の記録の置き場を返す
   * @returns D1、R2、MASTER_KEY
   */
  #transcripts(): TranscriptStore {
    return { db: this.env.DB, files: this.env.FILES, master: this.env.MASTER_KEY };
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
    return this.#run((book) => book.rebuildDay(day, now), now);
  }

  /**
   * 記憶を変える操作を流し、何も返さない
   * @param step StaffBook の操作
   * @param now 操作の時刻。状態が変わったら画面に配る
   * @returns 無し
   */
  async #run(step: (book: StaffBook) => Promise<void>, now: number): Promise<null> {
    await this.#serial(step, now);
    return null;
  }

  /**
   * 操作を 1 つずつ順に流す。D1 を待つ間に alarm やほかの呼び出しが割り込むと、開いている区分が割れる
   * blockConcurrencyWhile の中で投げると DO が作り直されるので使わない。断られた操作は鎖の外で投げ、鎖は次へ進める
   * @param step StaffBook の操作
   * @param now 記憶を変える操作の時刻。渡した時は、状態か今のタスクが変わったら画面に配る
   * @returns 操作の答え
   */
  async #serial<T>(step: (book: StaffBook) => Promise<T>, now?: number): Promise<T> {
    const settled = this.#chain.then(async () => {
      try {
        const book = await this.#open();
        const value = await step(book);
        if (now !== undefined) await this.#announce(book, now);
        return { ok: true as const, value };
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
   * 状態か今のタスクが前に配った物と変わっていれば、画面に配る。起き直した後の 1 回目は、変わっていなくても配る
   * @param book StaffBook
   * @param now 今の時刻
   */
  async #announce(book: StaffBook, now: number): Promise<void> {
    const s = await book.status(now);
    const key = `${s.state}/${s.nodeId ?? ""}`;
    if (key === this.#published) return;
    this.#published = key;
    // 配れなくても勤務の操作は止めない。announce がエラーログに残す
    await announce(this.env, { type: "staff", staff: { id: s.id, state: s.state, nodeId: s.nodeId } }, { now: () => now });
  }

  /**
   * ワークスペースのコンテナを動かす口を作る。起きるまで最長 4 分ほど掛かるので、勤務の鎖を止めないよう待たずに頼む
   * 失敗は log に残し、ハートビートが届かない事から StaffBook が workspace_down で拾い、作り直す
   * @param staffId 社員 ID
   * @returns StaffBook に渡す口
   */
  #workspace(staffId: StaffId): Workspace {
    const request = (name: string, step: (stub: DurableObjectStub<WorkspaceContainer>) => Promise<null>): Promise<void> => {
      // 待たずに頼む。DO は呼び出しの後も動いているので、頼んだ物は最後まで走る。頼んだ順に流し、書き残させ終える前に止めない
      this.#workspaceChain = this.#workspaceChain
        .then(() => step(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(staffId))))
        .catch((error: unknown) => {
          // 起きなかった時の通知は WorkspaceBox が出す。ここは呼び出しの失敗を残すだけ
          log("error", "workspace_call_failed", { staffId, call: name, error: error instanceof Error ? error.message : "unknown" });
        });
      return Promise.resolve();
    };
    return {
      start: () => request("start", (stub) => stub.start(staffId)),
      stop: () => request("stop", (stub) => stub.stop()),
      wrapUp: () => request("wrapUp", (stub) => stub.wrapUp()),
      // 止め終えるまでワークスペースは次の runs を断るので、止め終えた後に次のタスクを取る。時刻は離れた時刻に待った長さを足す
      abort: (now) => {
        const began = systemClock.now();
        return request("abort", async (stub) => {
          try {
            await stub.abort("task_left");
          } finally {
            await this.pull(now + Math.max(0, systemClock.now() - began));
          }
          return null;
        });
      },
      // 作り直した後は、持っているタスクの会話の記録を戻して続きを呼び、記録が無ければ最初から呼ぶ。止めている間は呼ばない
      restart: (now) =>
        request("restart", async (stub) => {
          await stub.restart(staffId);
          await continueRun(this.env, staffId, now);
          return null;
        }),
    };
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
    const staffId = parsed.data;
    this.#book = new StaffBook(
      staffId,
      this.ctx.storage,
      this.env.DB,
      this.#workspace(staffId),
      (noticeId) => announceNotice(this.env, noticeId, systemClock),
      // 書き直しても 1 行にするよう、出来事の ID をした仕事の行から決める
      (row) => appendNodeEvent(this.env, { nodeId: row.nodeId, staffId, kind: "continued", detail: {}, key: `continued:${row.workId}` }, { by: staffId, now: row.at }),
    );
    return this.#book;
  }
}
