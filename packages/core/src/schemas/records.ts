// 記録の集計の返す形。scope ごとか社員ごとの内訳と全体 (サービスと拡張の 3.4)
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
