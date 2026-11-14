// 社員と勤怠の形。社員 DO、ゲートウェイ、画面が共に使う (社員と勤怠の 1 章と 2 章、データの 2.2)
import { z } from "./zod.ts";

/** 社員 ID。役割ごとに 1 人 */
export const StaffId = z.enum(["president", "builder", "reviewer"]);

/** 社員 ID の型 */
export type StaffId = z.infer<typeof StaffId>;

/** 社員 DO の状態。社員と勤怠の 3.1 */
export const StaffState = z.enum(["off", "working", "wrapping", "called", "stopped", "waiting"]);

/** 社員 DO の状態の型 */
export type StaffState = z.infer<typeof StaffState>;

/** 勤怠の区分。働いた時間に入るのは前の 3 つ */
export const AttendanceKind = z.enum(["scheduled", "extension", "call", "stopped", "waiting"]);

/** 勤怠の区分の型 */
export type AttendanceKind = z.infer<typeof AttendanceKind>;

/** 働いた時間に入る区分 */
export const WORKED_KINDS = ["scheduled", "extension", "call"] as const satisfies readonly AttendanceKind[];

/** 勤怠の理由 */
export const AttendanceReason = z.enum(["schedule", "checkpoint_wait", "owner_instruction", "guard_stop", "rate_limit", "workspace_down"]);

/** 勤怠の理由の型 */
export type AttendanceReason = z.infer<typeof AttendanceReason>;

/** タスクを離れた時の結果。handed_back は上司に戻した、continued は次の日へ続く */
export const WorkResult = z.enum(["done", "handed_back", "stopped", "continued"]);

/** タスクを離れた時の結果の型 */
export type WorkResult = z.infer<typeof WorkResult>;

/** その日だけの指示の種類 */
export const OrderKind = z.enum(["extend", "leave_early", "off"]);

/** その日だけの指示の種類の型 */
export type OrderKind = z.infer<typeof OrderKind>;

/** 勤務の時刻。設定 `workday.schedule` の値。days は日本時間の曜日 (0 が日曜) */
export const WorkSchedule = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    days: z.array(z.number().int().min(0).max(6)),
  })
  .strict();

/** 勤務の時刻の型 */
export type WorkSchedule = z.infer<typeof WorkSchedule>;

/** 勤務の時刻の初期値。毎日 9 時から 17 時 */
export const DEFAULT_SCHEDULE: WorkSchedule = { start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4, 5, 6] };

/** ワークスペースが届けるチェックポイント。テストが通る、コミット、プルリクエスト、経過を書き残す */
export const CheckpointInput = z
  .object({
    kind: z.enum(["test_pass", "commit", "pr", "note"]),
    nodeId: z.uuid(),
    note: z.string().optional(),
  })
  .strict();

/** チェックポイントの型 */
export type CheckpointInput = z.infer<typeof CheckpointInput>;

/** 社員が手を付けるタスク。scope は office かサービスの ID */
export const StaffTask = z
  .object({
    nodeId: z.uuid(),
    title: z.string().min(1),
    scope: z.string().min(1),
  })
  .strict();

/** 社員が手を付けるタスクの型 */
export type StaffTask = z.infer<typeof StaffTask>;

/** 社員の今の状態 */
export const StaffStatus = z
  .object({
    id: StaffId,
    state: StaffState,
    nodeId: z.string().nullable(),
    nodeTitle: z.string().nullable(),
    workedMsToday: z.number().int(),
  })
  .strict();

/** 社員の今の状態の型 */
export type StaffStatus = z.infer<typeof StaffStatus>;

/** 1 日の勤怠のまとめ。daily_totals の行を返す形にした物。時刻は RFC 3339 の協定世界時 */
export const DaySummary = z
  .object({
    staffId: StaffId,
    day: z.iso.date(),
    clockIn: z.iso.datetime().nullable(),
    clockOut: z.iso.datetime().nullable(),
    workedMs: z.number().int(),
    extensionMs: z.number().int(),
    callMs: z.number().int(),
    stoppedMs: z.number().int(),
    waitingMs: z.number().int(),
    reasons: z.array(z.string()),
  })
  .strict()
  .meta({ id: "DaySummary" });

/** 1 日の勤怠のまとめの型 */
export type DaySummary = z.infer<typeof DaySummary>;

/** その日に手を付けたタスク 1 件。activeMs は止められていた時間と待っていた時間を除いた掛かった時間 */
export const WorkEntry = z
  .object({
    id: z.uuid(),
    nodeId: z.uuid(),
    scope: z.string(),
    title: z.string(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    activeMs: z.number().int(),
    result: WorkResult,
  })
  .strict()
  .meta({ id: "WorkEntry" });

/** その日に手を付けたタスク 1 件の型 */
export type WorkEntry = z.infer<typeof WorkEntry>;

/** 1 日の勤怠。表の上の 1 行のまとめと、タスク 1 件 1 行の明細 */
export const DayAttendance = z.object({ summary: DaySummary, entries: z.array(WorkEntry) }).strict().meta({ id: "DayAttendance" });

/** 1 日の勤怠の型 */
export type DayAttendance = z.infer<typeof DayAttendance>;

/** 勤怠の訂正の入力。元の行を置き換える値で、始まりは終わりより前 */
export const CorrectAttendanceInput = z
  .object({
    kind: AttendanceKind,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    reason: AttendanceReason,
    note: z.string().min(1),
  })
  .strict()
  .refine((v) => Date.parse(v.startedAt) < Date.parse(v.endedAt), { message: "終わりは始まりより後にする", path: ["endedAt"] })
  .meta({ id: "CorrectAttendanceInput" });

/** 勤怠の訂正の入力の型 */
export type CorrectAttendanceInput = z.infer<typeof CorrectAttendanceInput>;

/** 勤怠の 1 行。訂正の行は corrects に元の行の ID を持つ */
export const AttendanceRow = z
  .object({
    id: z.uuid(),
    staffId: StaffId,
    day: z.iso.date(),
    kind: AttendanceKind,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    reason: AttendanceReason,
    corrects: z.string().nullable(),
    note: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "AttendanceRow" });

/** 勤怠の 1 行の型 */
export type AttendanceRow = z.infer<typeof AttendanceRow>;
