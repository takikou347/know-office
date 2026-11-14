// 社員 1 人の勤務の時刻と勤怠の判断。StaffDO が持ち、テストは同じ物を手元の入れ物で使う (社員と勤怠の 3 章)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, CheckpointInput, jstDay, OrderKind, type StaffId, type StaffStatus, StaffTask, WorkResult } from "@know-office/core";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { attendance, workEntries } from "../db/main.ts";
import { correctAttendance, rebuildDailyTotals } from "./attendance.ts";
import { planDay, upcomingPlan } from "./plan.ts";
import { ACTIVE, EMPTY_MEMORY, HEARTBEAT_TIMEOUT_MS, Memory, RETRY_MS, Shift, WRAP_MS } from "./shift.ts";

/** 記憶の入れ物。DO の ctx.storage と同じ形。読んだ物は Zod で確かめてから使う */
export type StaffStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

/** 社員のワークスペースを動かす口。StaffBook は勤務の時刻に合わせて呼ぶ */
export type Workspace = {
  /** 出勤の時に起こす */
  start(): Promise<void>;
  /** 退勤の時に止める */
  stop(): Promise<void>;
  /** 30 分か 2 時間を過ぎた時に、経過を書き残させる */
  wrapUp(): Promise<void>;
  /** ハートビートが途切れた時に作り直す */
  restart(): Promise<void>;
};

/** 終わりまでがこれを切ると、新しいタスクを取る前に早い退勤を考える */
export const EARLY_WINDOW_MS = 15 * 60_000;

/** ゲートウェイが day_orders に足した指示の行 */
const DayOrder = z
  .object({
    id: z.string(),
    staffId: z.string(),
    day: z.string(),
    kind: OrderKind,
    until: z.number().nullable(),
    source: z.enum(["button", "chat"]),
    cancels: z.string().nullable(),
    createdAt: z.number(),
  })
  .strict();

/** 社員 1 人の勤務の時刻と勤怠を決める。時刻はすべて引数で受ける */
export class StaffBook {
  #orm;

  /**
   * @param staffId 社員 ID
   * @param storage 記憶と alarm の入れ物
   * @param db D1 の DB。勤怠、日ごとの集計、した仕事を書く
   * @param workspace ワークスペースを動かす口
   */
  constructor(
    private readonly staffId: StaffId,
    private readonly storage: StaffStorage,
    private readonly db: D1Database,
    private readonly workspace: Workspace,
  ) {
    this.#orm = drizzle(db);
  }

  /**
   * その時刻までに来た出来事 (始まり、終わり、30 分と 2 時間の期限、途切れたハートビート) を処理し、次の alarm を掛ける
   * @param now 今の時刻
   * @returns 無し
   */
  async wake(now: number): Promise<void> {
    const s = await this.#load();
    await this.#refresh(s, now);
    await this.#process(s, now);
    await this.#save(s, now);
  }

  /**
   * 今の状態を返す。記憶を変えない
   * @param now 今の時刻
   * @returns 状態、今のタスク、今日の働いた時間
   */
  async status(now: number): Promise<StaffStatus> {
    return (await this.#load()).status(now, jstDay(now));
  }

  /**
   * ワークスペースのハートビートを受ける。途切れて待っていたなら、前の区分を開き直す
   * @param receivedAt 受けた時刻
   * @returns 無し
   */
  async heartbeat(receivedAt: number): Promise<void> {
    const s = await this.#load();
    if (s.m.state === "off" || s.m.state === "stopped") return;
    s.m.heartbeatAt = receivedAt;
    if (s.m.state === "waiting" && s.m.open?.reason === "workspace_down") s.resume(receivedAt);
    await this.#save(s, receivedAt);
  }

  /**
   * チェックポイントを受ける。終わりの時刻を過ぎていたか、呼び出しの途中なら退勤する
   * @param input CheckpointInput
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 形が違う時
   * @throws conflict 今のタスクと違う時
   */
  async checkpoint(input: unknown, now: number): Promise<void> {
    const parsed = CheckpointInput.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "チェックポイントの形が違う");
    const s = await this.#load();
    if (s.m.task?.nodeId !== parsed.data.nodeId) throw new AppError("conflict", "今のタスクと違うチェックポイント");
    await this.#process(s, now);
    if (s.m.state === "wrapping" || s.m.state === "called") await this.#clockOut(s, now);
    await this.#save(s, now);
  }

  /**
   * 新しいタスクを取るかを決める。終わりまで 15 分を切り、中央値が残りより長ければ取らずに退勤する
   * @param input StaffTask
   * @param medianMs 同じ種類のタスクがチェックポイントに届くまでの直前 7 日の中央値。無ければ null
   * @param now 今の時刻
   * @returns 取ったか
   * @throws validation_failed 形が違う時
   * @throws conflict もうタスクを持っている時
   */
  async take(input: unknown, medianMs: number | null, now: number): Promise<{ taken: boolean }> {
    const parsed = StaffTask.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "タスクの形が違う");
    const s = await this.#load();
    await this.#process(s, now);
    const plan = s.m.plan;
    let taken = false;
    if (s.m.state === "working" && plan) {
      if (s.m.task) throw new AppError("conflict", "もうタスクを持っている");
      const left = plan.end - now;
      const leave = left < EARLY_WINDOW_MS && medianMs !== null && medianMs > left;
      if (leave) {
        s.m.reasons.push("leave_early:schedule");
        await this.#clockOut(s, now);
      } else s.m.task = { ...parsed.data, startedAt: now, pausedMs: 0, pausedAt: null };
      taken = s.m.task !== null;
    }
    await this.#save(s, now);
    return { taken };
  }

  /**
   * 今のタスクを離れ、した仕事を 1 行残す。終わりの時刻を過ぎていたか、呼び出しの途中なら退勤する
   * @param input WorkResult
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 形が違う時
   * @throws conflict タスクを持っていない時
   */
  async finish(input: unknown, now: number): Promise<void> {
    const parsed = WorkResult.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "結果の形が違う");
    const s = await this.#load();
    if (!s.m.task) throw new AppError("conflict", "タスクを持っていない");
    await this.#process(s, now);
    s.closeTask(now, parsed.data);
    if (s.m.state === "wrapping" || s.m.state === "called") await this.#clockOut(s, now);
    await this.#save(s, now);
  }

  /**
   * その日だけの指示を受け、予定を作り直す。指示はゲートウェイが先に day_orders に足す
   * @param input day_orders の行
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 形が違うか、ほかの社員の指示の時
   */
  async order(input: unknown, now: number): Promise<void> {
    const parsed = DayOrder.safeParse(input);
    if (!parsed.success || parsed.data.staffId !== this.staffId) throw new AppError("validation_failed", "指示の形が違う");
    await this.wake(now);
  }

  /**
   * 時間外に呼び出す。この社員だけが出勤し、頼まれたタスクがチェックポイントに届くまで働く
   * @param input StaffTask
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 形が違う時
   */
  async call(input: unknown, now: number): Promise<void> {
    const parsed = StaffTask.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "タスクの形が違う");
    const s = await this.#load();
    await this.#process(s, now);
    // 勤務中ならゲートウェイがワークスペースに渡すので、ここでは何もしない
    if (s.m.state === "off") {
      await this.#clockIn(s, now, jstDay(now), "called", "call", "owner_instruction");
      s.m.task = { ...parsed.data, startedAt: now, pausedMs: 0, pausedAt: null };
    }
    await this.#save(s, now);
  }

  /**
   * API の上限で待ち始める
   * @param input rate_limit
   * @param now 今の時刻
   * @returns 無し
   * @throws validation_failed 理由が違う時
   */
  async waitStart(input: unknown, now: number): Promise<void> {
    if (!z.literal("rate_limit").safeParse(input).success) throw new AppError("validation_failed", "待ちの理由が違う");
    const s = await this.#load();
    await this.#process(s, now);
    if (ACTIVE.includes(s.m.state)) s.pause(now, "waiting", "rate_limit");
    await this.#save(s, now);
  }

  /**
   * API の上限の待ちを解く
   * @param now 今の時刻
   * @returns 無し
   */
  async waitEnd(now: number): Promise<void> {
    const s = await this.#load();
    // alarm が遅れて上限を過ぎていれば、戻る前に上限の時刻で退勤する
    await this.#process(s, now);
    if (s.m.state === "waiting" && s.m.open?.reason === "rate_limit") s.resume(now);
    await this.#save(s, now);
  }

  /**
   * 自動停止で止める。止めていた間は働いた時間に入れない
   * @param now 今の時刻
   * @returns 無し
   */
  async stop(now: number): Promise<void> {
    const s = await this.#load();
    await this.#process(s, now);
    if (ACTIVE.includes(s.m.state)) s.pause(now, "stopped", "guard_stop");
    if (s.m.state === "waiting") {
      // 待っている間に止めても、戻る先は待つ前の区分のまま
      s.switch(now, "stopped", "guard_stop");
      s.m.state = "stopped";
    }
    await this.#save(s, now);
  }

  /**
   * 止めていたのを再開する
   * @param now 今の時刻
   * @returns 無し
   */
  async resume(now: number): Promise<void> {
    const s = await this.#load();
    // alarm が遅れて上限を過ぎていれば、戻る前に上限の時刻で退勤する
    await this.#process(s, now);
    if (s.m.state === "stopped") s.resume(now);
    await this.#save(s, now);
  }

  /**
   * 勤怠の行を訂正する。社員 DO の中で順に流すので、読んでから書くまでの間にほかの区分や訂正が入らない
   * @param originalId 訂正する行の ID
   * @param input 置き換える値
   * @param now 今の時刻
   * @returns 足した行の ID
   * @throws validation_failed 値の形が違う時
   * @throws not_found この社員の行が無い時
   * @throws conflict もう訂正された行か、直した区分がほかの区分と重なる時
   */
  async correct(originalId: string, input: unknown, now: number): Promise<{ id: string }> {
    return correctAttendance(this.db, this.staffId, originalId, input, now);
  }

  /**
   * 時刻で決まる出来事を、何も変わらなくなるまで順に処理する
   * @param s 記憶
   * @param now 今の時刻
   */
  async #process(s: Shift, now: number): Promise<void> {
    // 1 回の処理で移れる数は限られる。決まりの誤りで回り続けないよう上限を置く
    let moved = true;
    for (let n = 0; n < 8 && moved; n += 1) moved = await this.#step(s, now);
  }

  /**
   * 出来事を 1 つ処理する
   * @param s 記憶
   * @param now 今の時刻
   * @returns 何か変わったか
   */
  async #step(s: Shift, now: number): Promise<boolean> {
    const m = s.m;
    const plan = m.plan;
    if (m.state === "off") {
      if (!plan || plan.start > now || plan.end <= now) return false;
      m.handledDay = plan.day;
      if (!plan.off) {
        const extended = now >= plan.scheduledEnd;
        await this.#clockIn(s, now, plan.day, "working", extended ? "extension" : "scheduled", extended ? "owner_instruction" : "schedule");
        return true;
      }
      await rebuildDailyTotals(this.db, { staffId: this.staffId, day: plan.day, clockIn: null, out: false, reasons: [...m.reasons, "off:owner_instruction"] }, now);
      m.reasons = [];
      await this.#refresh(s, now);
      return true;
    }
    if (m.state === "stopped" || m.state === "waiting") return this.#paused(s, now);
    if (m.heartbeatAt !== null && now >= m.heartbeatAt + HEARTBEAT_TIMEOUT_MS) {
      // 最後のハートビートの後は動いていたか分からないので、そこで閉じる
      s.pause(m.heartbeatAt, "waiting", "workspace_down");
      await this.workspace.restart();
      m.retryAt = now + RETRY_MS;
      return true;
    }
    if (m.state !== "working") {
      if (m.deadline === null || now < m.deadline) return false;
      await this.workspace.wrapUp();
      await this.#clockOut(s, now);
      return true;
    }
    const end = plan?.off === false ? plan.end : now;
    if (plan && m.open?.kind === "scheduled" && now >= plan.scheduledEnd && end > plan.scheduledEnd) {
      s.switch(plan.scheduledEnd, "extension", "owner_instruction");
      return true;
    }
    if (now < end) return false;
    if (plan?.off) m.reasons.push("off:owner_instruction");
    else if (plan?.early) m.reasons.push("leave_early:owner_instruction");
    if (!m.task) {
      await this.#clockOut(s, now);
      return true;
    }
    s.switch(now, "extension", "checkpoint_wait");
    m.state = "wrapping";
    m.deadline = now + WRAP_MS;
    return true;
  }

  /**
   * stopped と waiting の間の出来事を 1 つ処理する。上限を過ぎれば上限の時刻で退勤し、ワークスペースが落ちたままなら 5 分ごとに作り直す
   * @param s 記憶
   * @param now 今の時刻
   * @returns 何か変わったか
   */
  async #paused(s: Shift, now: number): Promise<boolean> {
    const m = s.m;
    const limit = s.pauseLimit();
    if (limit !== null && now >= limit) {
      await this.#clockOut(s, limit);
      return true;
    }
    if (m.state === "waiting" && m.open?.reason === "workspace_down" && m.retryAt !== null && now >= m.retryAt) {
      await this.workspace.restart();
      m.retryAt = now + RETRY_MS;
      return true;
    }
    return false;
  }

  /**
   * 出勤する。区分を開き、ワークスペースを起こし、出勤を集計に残す
   * @param s 記憶
   * @param now 今の時刻
   * @param day 勤務の日
   * @param state working か called
   * @param kind 開く区分
   * @param reason 開く区分の理由
   */
  async #clockIn(s: Shift, now: number, day: string, state: "working" | "called", kind: "scheduled" | "extension" | "call", reason: "schedule" | "owner_instruction"): Promise<void> {
    s.clockIn(now, day, state, kind, reason);
    await this.workspace.start();
    await this.#commit(s);
    await rebuildDailyTotals(this.db, { staffId: this.staffId, day, clockIn: now, out: false, reasons: [] }, now);
  }

  /**
   * 退勤する。区分とタスクを閉じ、ワークスペースを止め、集計を作り直し、次の予定を読む
   * @param s 記憶
   * @param now 今の時刻
   */
  async #clockOut(s: Shift, now: number): Promise<void> {
    s.clockOut(now);
    await this.#commit(s);
    await this.workspace.stop();
    if (s.m.day) await rebuildDailyTotals(this.db, { staffId: this.staffId, day: s.m.day, clockIn: null, out: true, reasons: s.m.reasons }, now);
    s.m.reasons = [];
    await this.#refresh(s, now);
  }

  /**
   * 溜めた行を書く。先に記憶に書いてから、D1 に同じ ID で 1 度だけ書く。間で落ちても、起き直した時に同じ行を書き直すだけで済む
   * @param s 記憶
   */
  async #commit(s: Shift): Promise<void> {
    const { attendance: segments, work } = s.m.pending;
    const statements: BatchItem<"sqlite">[] = [
      ...segments.map((row) => this.#orm.insert(attendance).values(row).onConflictDoNothing()),
      ...work.map((row) => this.#orm.insert(workEntries).values(row).onConflictDoNothing()),
    ];
    const [first, ...rest] = statements;
    if (!first) return;
    await this.storage.put("memory", s.m);
    await this.#orm.batch([first, ...rest]);
    s.m.pending = { attendance: [], work: [] };
  }

  /**
   * 予定を D1 から読み直す。勤務中はその日の予定、off なら次に始まる予定
   * @param s 記憶
   * @param now 今の時刻
   */
  async #refresh(s: Shift, now: number): Promise<void> {
    const m = s.m;
    // 呼び出しは勤務の日の予定に縛られない
    if (m.state === "called" || m.back?.state === "called") return;
    if (m.state === "off") m.plan = await upcomingPlan(this.db, this.staffId, now, m.handledDay);
    else if (m.day) m.plan = await planDay(this.db, this.staffId, m.day);
  }

  /**
   * 記憶を読む。無ければ off から始める
   * @returns 記憶
   */
  async #load(): Promise<Shift> {
    const stored = await this.storage.get("memory");
    const s = new Shift(this.staffId, stored === undefined ? structuredClone(EMPTY_MEMORY) : Memory.parse(stored));
    // 前の操作が D1 に書いた後、記憶を書く前に落ちていれば、溜めた行をもう一度書く
    await this.#commit(s);
    return s;
  }

  /**
   * 溜めた行を書き、記憶を書き、次の出来事の時刻に alarm を掛ける
   * @param s 記憶
   * @param now 今の時刻
   */
  async #save(s: Shift, now: number): Promise<void> {
    await this.#commit(s);
    await this.storage.put("memory", s.m);
    const next = s.next(now);
    if (next === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(next);
  }
}
