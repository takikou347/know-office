// 記録の集計の返す形。scope ごとか社員ごとの内訳と全体 (サービスと拡張の 3.4)
import { Notice } from "./notices.ts";
import { Approval, Node } from "./work.ts";
import { StaffId, StaffOverview } from "./workday.ts";
import { z } from "./zod.ts";

/** 集計の分け方。service は office とサービスごと、staff は社員ごと */
export const RecordGroup = z.enum(["service", "staff"]);

/** 集計の分け方の型 */
export type RecordGroup = z.infer<typeof RecordGroup>;

const totals = {
  workedMs: z.number().int(),
  tasks: z.number().int(),
  costMicroUsd: z.number().int(),
  tokens: z.number().int(),
  deploys: z.number().int(),
  failureRatio: z.number(),
};

/** 1 つの分の集計。掛けた時間、終えたタスクの数、費用、トークン、デプロイの回数、失敗率 */
export const RecordTotals = z.object(totals).strict();

/** 1 つの分の集計の型 */
export type RecordTotals = z.infer<typeof RecordTotals>;

/** 記録の集計。total の足せる値は rows の和と同じ */
export const RecordSummary = z
  .object({
    group: RecordGroup,
    rows: z.array(
      z
        .object({
          key: z.string().openapi({ description: "`group` が service なら `office` かサービスの ID、staff なら社員 ID" }),
          name: z.string().openapi({ description: "サービスの名前、`office`、社員の役の名前" }),
          ...totals,
        })
        .strict(),
    ),
    total: RecordTotals.openapi({ description: "全体の値。足せる値は `rows` の和と同じ" }),
  })
  .strict()
  .meta({ id: "RecordSummary" });

/** 記録の集計の型 */
export type RecordSummary = z.infer<typeof RecordSummary>;

/** 勤怠の履歴を読むクエリ。日は日本時間、cursor は前のページの最後の「<日>.<社員 ID>」 */
export const AttendanceQuery = z
  .object({
    from: z.iso.date().optional().openapi({ param: { name: "from", in: "query" }, description: "日本時間の日付 YYYY-MM-DD" }),
    to: z.iso.date().optional().openapi({ param: { name: "to", in: "query" }, description: "日本時間の日付 YYYY-MM-DD" }),
    staffId: StaffId.optional().openapi({ param: { name: "staffId", in: "query" }, description: "社員 ID。役割ごとに固定" }),
  })
  .strict();

/** ダッシュボード。社員、承認待ち、今日のタスク、日本時間の今月の費用、未読の通知 */
export const Dashboard = z
  .object({
    staff: z.array(StaffOverview),
    approvals: z.array(Approval),
    todayTasks: z.array(Node),
    monthCostMicroUsd: z.number().int(),
    notices: z.array(Notice),
  })
  .strict()
  .meta({ id: "Dashboard" });

/** ダッシュボードの型 */
export type Dashboard = z.infer<typeof Dashboard>;
