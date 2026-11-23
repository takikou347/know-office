// 社員と勤怠の形。社員 DO、ゲートウェイ、画面が共に使う (社員と勤怠の 2 章と 2 章、データの 2 章)
import { z } from "./zod.ts";
import { ATTENDANCE_KINDS } from "../master/attendance-kinds.ts";
import { DAY_ORDER_KINDS } from "../master/day-order-kinds.ts";
import { masterSchema } from "../master/master.ts";

/** 社員の職種。職種がツール、作業の種類、割り当てを決める。社長はちょうど 1 人 */
export const StaffJob = z.enum(["president", "builder", "reviewer"]);

/** 社員の職種の型 */
export type StaffJob = z.infer<typeof StaffJob>;

/** 社員 ID。最初の 3 人は職種と同じ名前で、足した社員はゲートウェイが `<職種>-<小文字と数字の 6 字>` で作る。オーナーやゲートウェイの名前 (owner、system など) とは重ならない */
export const StaffId = z.string().regex(/^(president|builder|reviewer)(-[a-z0-9]{6})?$/);

/** 社員 ID の型 */
export type StaffId = z.infer<typeof StaffId>;

/** 社員 DO の状態。社員と勤怠の 3.1 */
export const StaffState = z.enum(["off", "working", "wrapping", "called", "stopped", "waiting"]);

/** 社員 DO の状態の型 */
export type StaffState = z.infer<typeof StaffState>;

/** 勤怠の区分。働いた時間に入るのは前の 3 つ */
export const AttendanceKind = masterSchema(ATTENDANCE_KINDS);

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
export const OrderKind = masterSchema(DAY_ORDER_KINDS);

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

/** 時間外の話しかけで社員を呼び出すか。設定 `workday.offHoursCall` の値。perDay は社員ごとの 1 日の回数 */
export const OffHoursCall = z
  .object({
    enabled: z.boolean().meta({ description: "時間外に話しかけた時に社員を呼び出すか。開くと Claude の費用が出る" }),
    perDay: z.number().int().min(1).max(10).meta({ description: "社員ごとの 1 日の呼び出しの回数。1 回は 2 時間まで" }),
  })
  .strict();

/** 時間外の呼び出しの設定の型 */
export type OffHoursCall = z.infer<typeof OffHoursCall>;

/** 時間外の呼び出しの初期値。閉じて 1 日 2 回 */
export const DEFAULT_OFF_HOURS_CALL: OffHoursCall = { enabled: false, perDay: 2 };

/** 会話の言葉から勤務の指示を抜き出すか。設定 `workday.chatOrders` の値。perDay は office 全体の 1 日の回数 */
export const ChatOrders = z
  .object({
    enabled: z.boolean().meta({ description: "オーナーの発言から勤務の指示を Haiku で抜き出すか。開くと Claude の費用が出る" }),
    perDay: z.number().int().min(1).max(100).meta({ description: "office 全体の 1 日の抜き出しの回数。1 回は入力 2,000 字、出力 300 トークンまで" }),
  })
  .strict();

/** 会話の言葉の指示の設定の型 */
export type ChatOrders = z.infer<typeof ChatOrders>;

/** 会話の言葉の指示の初期値。閉じて 1 日 20 回 */
export const DEFAULT_CHAT_ORDERS: ChatOrders = { enabled: false, perDay: 20 };

/** ワークスペースが届けるチェックポイント。テストが通る、コミット、プルリクエスト、経過を書き残す */
export const CheckpointInput = z
  .object({
    kind: z.enum(["test_pass", "commit", "pr", "note"]),
    nodeId: z.uuid().meta({ description: "UUID v7" }),
    note: z.string().optional(),
  })
  .strict()
  .meta({ id: "CheckpointInput" });

/** チェックポイントの型 */
export type CheckpointInput = z.infer<typeof CheckpointInput>;

/** 社員が手を付けるタスク。scope は office かサービスの ID */
export const StaffTask = z
  .object({
    nodeId: z.uuid(),
    title: z.string().min(1),
    scope: z.string().min(1),
    /** 始めた時の役目の説明文の版。続きもこの版で呼ぶ */
    promptVersion: z.number().int().positive().optional(),
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

/** 社員の一覧の 1 人。今の状態に、組織図の役の名前とモデルを足した物 */
export const StaffOverview = z
  .object({
    id: StaffId.meta({ description: "社員 ID" }),
    job: StaffJob,
    role: z.string(),
    bossId: StaffId.nullable(),
    model: z.string(),
    schedule: WorkSchedule.nullable().meta({ description: "この社員だけの勤務の時刻。null は全体の勤務の時刻" }),
    version: z.number().int().meta({ description: "設定の版。設定を直す時に送る" }),
    state: StaffState,
    nodeId: z.string().nullable(),
    nodeTitle: z.string().nullable(),
    workedMsToday: z.number().int(),
  })
  .strict()
  .meta({ id: "StaffOverview", description: "社員の一覧の 1 人。今の状態に、組織図の役の名前とモデルを足した物" });

/** 社員の一覧の 1 人の型 */
export type StaffOverview = z.infer<typeof StaffOverview>;

const StaffName = z.string().trim().min(1).max(40);
const StaffModel = z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

/** 社員を足す入力。社長は足せない */
export const CreateStaffInput = z
  .object({
    job: z.enum(["builder", "reviewer"]),
    role: StaffName.meta({ description: "画面に出す名前" }),
    bossId: StaffId.meta({ description: "上司の社員 ID。在籍の社員" }),
    model: StaffModel,
  })
  .strict()
  .meta({ id: "CreateStaffInput" });

/** 社員を足す入力の型 */
export type CreateStaffInput = z.infer<typeof CreateStaffInput>;

/** 社員の設定を直す入力。送った項目だけを直す */
export const UpdateStaffInput = z
  .object({
    version: z.number().int().meta({ description: "読んだ時の設定の版。今と違えば 409 conflict" }),
    role: StaffName.optional(),
    bossId: StaffId.optional().meta({ description: "上司の社員 ID。社長には送れない" }),
    model: StaffModel.optional(),
    schedule: WorkSchedule.nullable().optional().meta({ description: "この社員だけの勤務の時刻。null で全体の勤務の時刻に戻す" }),
  })
  .strict()
  .meta({ id: "UpdateStaffInput" });

/** 社員の設定を直す入力の型 */
export type UpdateStaffInput = z.infer<typeof UpdateStaffInput>;

/** その日だけの指示を出す入力。extend と leave_early は日本時間の終わりの時刻 until が要り、off は持たない */
export const CreateOrderInput = z
  .object({
    day: z.iso.date().openapi({ description: "日本時間の日付 YYYY-MM-DD" }),
    kind: OrderKind,
    until: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional()
      .openapi({ description: "extend と leave_early の時は必須。日本時間の HH:MM" }),
  })
  .strict()
  .refine((v) => (v.kind === "off") === (v.until === undefined), { message: "extend と leave_early は until が要り、off は持たない", path: ["until"] })
  .meta({ id: "CreateOrderInput" });

/** その日だけの指示を出す入力の型 */
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

/** その日だけの指示。until は日本時間の HH:MM、cancelledAt は取り消した時刻 */
export const Order = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    staffId: StaffId.meta({ description: "社員 ID。役割ごとに固定" }),
    day: z.iso.date().openapi({ description: "日本時間の日付 YYYY-MM-DD" }),
    kind: OrderKind,
    until: z.string().nullable(),
    source: z.enum(["button", "chat"]),
    cancelledAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .meta({ id: "Order" });

/** その日だけの指示の型 */
export type Order = z.infer<typeof Order>;

/** 1 日の勤怠のまとめ。daily_totals の行を返す形にした物。時刻は RFC 3339 の協定世界時 */
export const DaySummary = z
  .object({
    staffId: StaffId.meta({ description: "社員 ID。役割ごとに固定" }),
    day: z.iso.date().meta({ description: "日本時間の日付 YYYY-MM-DD" }),
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
    id: z.uuid().meta({ description: "UUID v7" }),
    nodeId: z.uuid().meta({ description: "UUID v7" }),
    scope: z.string().meta({ description: "`office` またはサービスの ID" }),
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
    id: z.uuid().meta({ description: "UUID v7" }),
    staffId: StaffId.meta({ description: "社員 ID。役割ごとに固定" }),
    day: z.iso.date().meta({ description: "日本時間の日付 YYYY-MM-DD" }),
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
