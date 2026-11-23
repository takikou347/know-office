// 記録の集計の返す形。scope ごとか社員ごとの内訳と全体 (サービスと拡張の 3.4)
import { Notice } from "./notices.ts";
import { ServiceKind, ServiceStage, ServiceStatus } from "./services.ts";
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

/** オーナーの判断を待つレビュー 1 件。main に入れる条件にオーナーの承認があり、レビュー担当が承認し、オーナーがまだ決めていない物 */
export const OwnerReview = z
  .object({
    nodeId: z.uuid().openapi({ description: "作った社員のタスク ID。レビューはこのタスクの画面で開く" }),
    title: z.string(),
    assignee: StaffId.nullable().openapi({ description: "作った社員" }),
    repo: z.string(),
    prNumber: z.number().int().positive(),
    headSha: z.string().openapi({ description: "レビュー担当が見た `head_sha`。ホームで承認か差し戻しを出す時の `baseSha`" }),
    requestedAt: z.iso.datetime().openapi({ description: "タスクを最後に変えた時刻。レビューを頼んだ時に変わる" }),
  })
  .strict()
  .meta({ id: "OwnerReview" });

/** オーナーの判断を待つレビュー 1 件の型 */
export type OwnerReview = z.infer<typeof OwnerReview>;

/** 日本時間の 1 日の費用 */
export const DailyCost = z
  .object({ day: z.string().openapi({ description: "日本時間の日 YYYY-MM-DD" }), costMicroUsd: z.number().int() })
  .strict()
  .meta({ id: "DailyCost" });

/** 日本時間の 1 日の費用の型 */
export type DailyCost = z.infer<typeof DailyCost>;

/** ホームに出すサービス 1 件の数値。種類ごとの様子をそのまま持つ */
export const HomeService = z
  .object({ id: z.uuid(), name: z.string(), kind: ServiceKind, stage: ServiceStage, status: ServiceStatus })
  .strict()
  .meta({ id: "HomeService" });

/** ホームに出すサービス 1 件の数値の型 */
export type HomeService = z.infer<typeof HomeService>;

/** ホーム。社員、承認待ち、オーナーの判断を待つレビュー、今日のタスク、日本時間の今月の費用と日ごとの推移、動いているサービスの数値、未読の通知 */
export const Dashboard = z
  .object({
    staff: z.array(StaffOverview),
    approvals: z.array(Approval),
    ownerReviews: z.array(OwnerReview).openapi({ description: "オーナーの判断を待つレビューを古い順に 100 件まで" }),
    todayTasks: z.array(Node),
    monthCostMicroUsd: z.number().int(),
    dailyCosts: z.array(DailyCost).openapi({ description: "日本時間の今月の 1 日から今日までの日ごとの費用" }),
    services: z.array(HomeService).openapi({ description: "試作、サービス、運用の段階のサービスを ID の順に 50 件まで" }),
    notices: z.array(Notice),
  })
  .strict()
  .meta({ id: "Dashboard" });

/** ダッシュボードの型 */
export type Dashboard = z.infer<typeof Dashboard>;

/** 日本時間の月 YYYY-MM。月は 01 から 12 */
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** GET /api/v1/records/uptime のクエリ */
export const UptimeQuery = z.object({ month: Month.openapi({ param: { name: "month", in: "query", required: true } }) }).strict();

/** 月の稼働率。ratio は health_checks の通った割合で、確かめが無い月は null */
export const Uptime = z
  .object({
    month: z.string().meta({ description: "日本時間の月 YYYY-MM" }),
    ratio: z.number().nullable().meta({ description: "通った割合。確かめが無い月は null" }),
    checks: z.number().int().meta({ description: "確かめた件数" }),
  })
  .strict()
  .meta({ id: "Uptime" });

/** 月の稼働率の型 */
export type Uptime = z.infer<typeof Uptime>;
