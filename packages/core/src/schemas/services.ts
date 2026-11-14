// サービスの返す形と入力。アイデアから運用までの流れ (サービスと拡張の 3.1、データの 2.6)
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** サービスの種類。ライブラリ、Web アプリ、コンテンツ */
export const ServiceKind = z.enum(["library", "web_app", "content"]);

/** サービスの種類の型 */
export type ServiceKind = z.infer<typeof ServiceKind>;

/** サービスの段階。アイデア、検討、試作、サービス、運用と、見送った、閉じた */
export const ServiceStage = z.enum(["idea", "study", "prototype", "service", "operation", "dropped", "closed"]);

/** サービスの段階の型 */
export type ServiceStage = z.infer<typeof ServiceStage>;

/** オーナーが移せる先。idea へは戻せない */
export const AdvanceStage = ServiceStage.exclude(["idea"]);

/** 移れる段階。段階を飛ばさず、見送りは作るまで、閉じるのはサービスと運用だけ */
export const NEXT_STAGES: Record<ServiceStage, readonly ServiceStage[]> = {
  idea: ["study", "dropped"],
  study: ["prototype", "dropped"],
  prototype: ["service", "dropped"],
  service: ["operation", "closed"],
  operation: ["closed"],
  dropped: [],
  closed: [],
};

/** 社員が閉じる案を出せる段階 */
export const CLOSABLE_STAGES = ["service", "operation"] as const satisfies readonly ServiceStage[];

/** サービスの一覧の 1 件 */
export const ServiceCard = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    name: z.string(),
    kind: ServiceKind,
    stage: ServiceStage,
    staffId: z.string().nullable(),
    repo: z.string().nullable(),
  })
  .strict()
  .meta({ id: "ServiceCard" });

/** サービスの一覧の 1 件の型 */
export type ServiceCard = z.infer<typeof ServiceCard>;

/** サービスの出来事 */
const ServiceEvent = z
  .object({
    at: z.iso.datetime(),
    kind: z.enum(["stage", "deploy", "rollback", "release"]),
    by: z.string().openapi({ description: "`owner`、社員 ID、`system` のどれか" }),
    detail: z.record(z.string(), z.unknown()).openapi({ additionalProperties: true, description: "段階の出来事は移った先の `to` と理由の `reason` を持つ" }),
  })
  .strict();

/** サービスの詳細。案の中身、検討の材料、見送った理由、出来事を持つ */
export const ServiceDetail = z
  .intersection(
    ServiceCard,
    z
      .object({
        aim: z.string(),
        users: z.string(),
        costEstimateMicroUsd: z.number().int().openapi({ description: "月の費用の見込み" }),
        revenueEstimateMicroUsd: z.number().int().openapi({ description: "月の売り上げの見込み" }),
        study: z.string().nullable().openapi({ description: "社長が調べた検討の材料。まだ無ければ null" }),
        droppedReason: z.string().nullable().openapi({ description: "見送った理由。見送っていなければ null" }),
        metrics: z.record(z.string(), z.unknown()).openapi({ additionalProperties: true }),
        events: z.array(ServiceEvent),
      })
      .strict(),
  )
  .meta({ id: "ServiceDetail" });

/** サービスの詳細の型 */
export type ServiceDetail = z.infer<typeof ServiceDetail>;

// お金は月の見込みのマイクロドル。JSON で崩れない整数の範囲にする
const MicroUsd = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** 案を足す入力。オーナーの API と社員の idea_add が同じ形を使う */
export const CreateIdeaInput = z
  .object({
    title: z.string().min(1).max(100),
    kind: ServiceKind,
    aim: z.string().min(1).max(2000),
    users: z.string().min(1).max(500),
    costEstimateMicroUsd: MicroUsd.openapi({ description: "月の費用の見込み" }),
    revenueEstimateMicroUsd: MicroUsd.openapi({ description: "月の売り上げの見込み" }),
  })
  .strict()
  .meta({ id: "CreateIdeaInput" });

/** 案を足す入力の型 */
export type CreateIdeaInput = z.infer<typeof CreateIdeaInput>;

/** 段階を移す入力。staffId は prototype に進める時に要る */
export const AdvanceInput = z
  .object({
    to: AdvanceStage,
    reason: z.string().min(1).max(2000),
    staffId: StaffId.optional().openapi({ description: "`prototype` に進める時に決める担当の社員" }),
  })
  .strict()
  .meta({ id: "AdvanceInput" });

/** 段階を移す入力の型 */
export type AdvanceInput = z.infer<typeof AdvanceInput>;
