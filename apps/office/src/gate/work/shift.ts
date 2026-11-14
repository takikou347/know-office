// 社員 DO の記憶と、区分の開け閉め。閉じた区分とした仕事は、ID を決めた行にして記憶に溜める (社員と勤怠の 3.1、3.5)
import { AttendanceKind, AttendanceReason, newId, type StaffId, StaffState, type StaffStatus, StaffTask, WORKED_KINDS, WorkResult } from "@know-office/core";
import { z } from "zod";
import { clockAt } from "./attendance.ts";
import { Plan } from "./plan.ts";

/** 終わりの時刻からチェックポイントを待つ長さ */
export const WRAP_MS = 30 * 60_000;
/** 時間外の呼び出しの最長 */
export const CALL_MS = 2 * 60 * 60_000;
/** ハートビートがこの間届かなければ途切れたとする */
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/** ワークスペースが戻らない間、作り直しを呼び直す間 */
export const RETRY_MS = 5 * 60_000;
/** 勤務中の状態。ハートビートと時刻の出来事を見る */
export const ACTIVE: readonly StaffState[] = ["working", "wrapping", "called"];

/** 開いている区分 */
const Segment = z.object({ kind: AttendanceKind, reason: AttendanceReason, startedAt: z.number() }).strict();

/** 持っているタスク。止められていた間と待っていた間は pausedMs に足す */
const HeldTask = StaffTask.extend({ startedAt: z.number(), pausedMs: z.number(), pausedAt: z.number().nullable() });

/** D1 に書く前の勤怠の行。ID は記憶に書く前に決め、D1 には同じ ID で 1 度だけ入る */
const PendingAttendance = z
  .object({
    id: z.string(),
    staffId: z.string(),
    day: z.string(),
    kind: AttendanceKind,
    startedAt: z.number(),
    endedAt: z.number(),
    reason: AttendanceReason,
    corrects: z.null(),
    note: z.null(),
    createdAt: z.number(),
  })
  .strict();

/** D1 に書く前のした仕事の行 */
const PendingWork = z
  .object({
    id: z.string(),
    staffId: z.string(),
    day: z.string(),
    nodeId: z.string(),
    scope: z.string(),
    title: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    activeMs: z.number(),
    result: WorkResult,
    corrects: z.null(),
  })
  .strict();

/** 退勤の後に作り直す日ごとの集計。区分が重なった時の通知の ID も退勤の時に決めるので、区分の行を書いた後に何度作り直しても、集計の値も通知も増えない */
const PendingTotals = z.object({ day: z.string(), reasons: z.array(z.string()), at: z.number(), noticeId: z.string() }).strict();

/** 社員 DO の記憶。DO が起き直しても残す */
export const Memory = z
  .object({
    state: StaffState,
    /** 今の勤務を始めた日本時間の日。日をまたいでも変えない */
    day: z.string().nullable(),
    /** 始まりの時刻を処理し終えた最後の日。同じ日に 2 度出勤しない */
    handledDay: z.string().nullable(),
    /** 勤務中はその日の予定、off なら次の予定 */
    plan: Plan.nullable(),
    open: Segment.nullable(),
    /** stopped と waiting から戻る先 */
    back: z.object({ state: StaffState, kind: AttendanceKind, reason: AttendanceReason }).strict().nullable(),
    task: HeldTask.nullable(),
    heartbeatAt: z.number().nullable(),
    /** wrapping は 30 分、called は 2 時間の期限。止められていた分と待っていた分だけ後へずらす */
    deadline: z.number().nullable(),
    /** stopped か waiting に入った時刻。戻る時に deadline をずらす */
    pausedFrom: z.number().nullable(),
    /** ワークスペースが落ちている間、次に作り直しを呼ぶ時刻 */
    retryAt: z.number().nullable(),
    /** day の閉じた区分のうち、働いた時間に入る分の和 */
    workedMs: z.number(),
    /** 次に集計を作り直す時に足す、勤怠の行に出ない理由 (`<出来事>:<理由>`) */
    reasons: z.array(z.string()),
    /** まだ D1 に書いたと確かめていない行と、まだ作り直したと確かめていない集計。起き直したら同じ ID で書き直し、集計を作り直す */
    pending: z.object({ attendance: z.array(PendingAttendance), work: z.array(PendingWork), totals: z.array(PendingTotals).default([]) }).strict(),
  })
  .strict();

/** 社員 DO の記憶の型 */
export type Memory = z.infer<typeof Memory>;

/** 何もしていない社員の記憶 */
export const EMPTY_MEMORY: Memory = {
  state: "off",
  day: null,
  handledDay: null,
  plan: null,
  open: null,
  back: null,
  task: null,
  heartbeatAt: null,
  deadline: null,
  pausedFrom: null,
  retryAt: null,
  workedMs: 0,
  reasons: [],
  pending: { attendance: [], work: [], totals: [] },
};

const isWorked = (kind: AttendanceKind) => (WORKED_KINDS as readonly string[]).includes(kind);

/** 記憶を持ち、区分を開け閉めし、D1 に書く行を記憶に溜める。時刻は引数で受け、D1 にもワークスペースにも触れない */
export class Shift {
  /**
   * @param staffId 社員 ID
   * @param m 記憶
   */
  constructor(
    readonly staffId: StaffId,
    readonly m: Memory,
  ) {}

  /**
   * 今の状態を返す
   * @param now 今の時刻
   * @param today 今の時刻の日本時間の日
   * @returns 状態、今のタスク、今日の働いた時間
   */
  status(now: number, today: string): StaffStatus {
    const m = this.m;
    const open = m.open && isWorked(m.open.kind) ? Math.max(0, now - m.open.startedAt) : 0;
    const counts = m.state !== "off" || m.day === today;
    return { id: this.staffId, state: m.state, nodeId: m.task?.nodeId ?? null, nodeTitle: m.task?.title ?? null, workedMsToday: counts ? m.workedMs + open : 0 };
  }

  /**
   * 出勤した形にする。区分を開き、ハートビートの待ちを始める
   * @param now 今の時刻
   * @param day 勤務の日
   * @param state working か called
   * @param kind 開く区分
   * @param reason 開く区分の理由
   */
  clockIn(now: number, day: string, state: "working" | "called", kind: AttendanceKind, reason: AttendanceReason): void {
    const m = this.m;
    if (m.day !== day) m.workedMs = 0;
    m.day = day;
    m.state = state;
    m.open = { kind, reason, startedAt: now };
    m.back = null;
    m.heartbeatAt = now;
    m.deadline = state === "called" ? now + CALL_MS : null;
  }

  /**
   * 退勤した形にする。持っているタスクは次の日へ続け、区分を閉じ、日ごとの集計の作り直しを溜める
   * @param now 今の時刻
   */
  clockOut(now: number): void {
    const m = this.m;
    if (m.task) this.closeTask(now, "continued");
    this.close(now);
    // 集計は区分の行と同じ流れで書く。間で落ちても、起き直した時に作り直す
    if (m.day) m.pending.totals.push({ day: m.day, reasons: m.reasons, at: now, noticeId: newId(clockAt(now)) });
    m.reasons = [];
    m.state = "off";
    m.back = null;
    m.deadline = null;
    m.heartbeatAt = null;
    m.pausedFrom = null;
    m.retryAt = null;
  }

  /**
   * 今の区分を閉じ、止められていた時間か待っていた時間を開く
   * @param from 閉じる時刻
   * @param state stopped か waiting
   * @param reason 開く区分の理由
   */
  pause(from: number, state: "stopped" | "waiting", reason: AttendanceReason): void {
    const m = this.m;
    if (!m.open) return;
    m.back = { state: m.state, kind: m.open.kind, reason: m.open.reason };
    this.switch(from, state, reason);
    m.state = state;
    m.pausedFrom = from;
    if (m.task && m.task.pausedAt === null) m.task.pausedAt = from;
  }

  /**
   * 止められていたか待っていたのを閉じ、前の区分を開き直す
   * @param now 今の時刻
   */
  resume(now: number): void {
    const m = this.m;
    if (!m.back) return;
    this.switch(now, m.back.kind, m.back.reason);
    m.state = m.back.state;
    m.back = null;
    m.heartbeatAt = now;
    // 止められていた間と待っていた間は、30 分と 2 時間の期限に数えない
    if (m.deadline !== null && m.pausedFrom !== null) m.deadline += now - m.pausedFrom;
    m.pausedFrom = null;
    m.retryAt = null;
    if (m.task && m.task.pausedAt !== null) {
      m.task.pausedMs += now - m.task.pausedAt;
      m.task.pausedAt = null;
    }
  }

  /**
   * 今の区分を閉じ、新しい区分を開く
   * @param from 切り替える時刻
   * @param kind 開く区分
   * @param reason 開く区分の理由
   */
  switch(from: number, kind: AttendanceKind, reason: AttendanceReason): void {
    this.close(from);
    this.m.open = { kind, reason, startedAt: from };
  }

  /**
   * 今の区分を閉じ、勤怠の行を 1 つ溜める。長さが 0 の区分は残さない
   * @param to 閉じる時刻
   */
  close(to: number): void {
    const m = this.m;
    const open = m.open;
    m.open = null;
    if (!open || !m.day || to <= open.startedAt) return;
    if (isWorked(open.kind)) m.workedMs += to - open.startedAt;
    m.pending.attendance.push({ id: newId(clockAt(to)), staffId: this.staffId, day: m.day, kind: open.kind, startedAt: open.startedAt, endedAt: to, reason: open.reason, corrects: null, note: null, createdAt: to });
  }

  /**
   * 持っているタスクを離れ、した仕事の行を 1 つ溜める。掛かった時間に止められていた間と待っていた間を入れない
   * @param now 今の時刻
   * @param result 結果
   */
  closeTask(now: number, result: WorkResult): void {
    const m = this.m;
    const task = m.task;
    m.task = null;
    if (!task || !m.day) return;
    const paused = task.pausedMs + (task.pausedAt === null ? 0 : now - task.pausedAt);
    m.pending.work.push({
      id: newId(clockAt(now)),
      staffId: this.staffId,
      day: m.day,
      nodeId: task.nodeId,
      scope: task.scope,
      title: task.title,
      startedAt: task.startedAt,
      endedAt: now,
      activeMs: Math.max(0, now - task.startedAt - paused),
      result,
      corrects: null,
    });
  }

  /**
   * stopped と waiting の上限を返す。呼び出しなら呼び出しの期限、ほかは終わりの時刻から 30 分
   * @returns 時刻。stopped と waiting でなければ null
   */
  pauseLimit(): number | null {
    const m = this.m;
    if (m.state !== "stopped" && m.state !== "waiting") return null;
    if (m.back?.state === "called") return m.deadline;
    return m.plan ? m.plan.end + WRAP_MS : null;
  }

  /**
   * 次の出来事の時刻を返す。alarm は 1 つしか掛けられないので最も早い物にする (社員と勤怠の 3.2)
   * @param now 今の時刻
   * @returns 時刻。待つ物が無ければ null
   */
  next(now: number): number | null {
    const m = this.m;
    const times: number[] = [];
    if (m.state === "off" && m.plan) times.push(m.plan.start);
    if (ACTIVE.includes(m.state) && m.heartbeatAt !== null) times.push(m.heartbeatAt + HEARTBEAT_TIMEOUT_MS);
    if ((m.state === "wrapping" || m.state === "called") && m.deadline !== null) times.push(m.deadline);
    const limit = this.pauseLimit();
    if (limit !== null) times.push(limit);
    if (m.state === "waiting" && m.retryAt !== null) times.push(m.retryAt);
    if (m.state === "working" && m.plan) {
      times.push(m.plan.off ? now : m.plan.end);
      if (m.open?.kind === "scheduled" && m.plan.end > m.plan.scheduledEnd) times.push(m.plan.scheduledEnd);
    }
    return times.length === 0 ? null : Math.max(now, Math.min(...times));
  }
}
