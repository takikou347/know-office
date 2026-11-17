// 社長のツール issue_plan の入力。設計書の機能ごとの親と、要件ごとの子の組を送る (開発の回し方の 3.3)
import { ISSUE_KINDS } from "../../devloop/issues.ts";
import { z } from "../zod.ts";

/** 機能のファイルの名前 (`<番号>-<名前>`)。設計書の道 `docs/04-detail/<機能>.md` に入るので、小文字、数字、- だけ */
export const FEATURE_NAME = /^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 1 回の issue_plan で送る親の数の上限。GitHub の書きの間を空けて 1 回の要求に収めるため、設計書の 3.3 と同じ数にする */
export const ISSUE_PLAN_PARENTS_MAX = 10;

/** 1 回の issue_plan で送る子の数の上限 */
export const ISSUE_PLAN_CHILDREN_MAX = 10;

/** 触るファイルの glob。リポジトリの頭からの道で、`..` と頭の `/` は断る */
const PathGlob = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), { message: "頭の / と .. は使えない" });

/** 子 Issue 1 件。要件 1 つ */
const IssuePlanChild = z
  .object({
    requirement: z.string().min(1).max(120).meta({ description: "詳細設計の要件の名前" }),
    kind: z.enum(ISSUE_KINDS),
    priority: z.literal("high").optional(),
    paths: z.array(PathGlob).min(1).max(20).meta({ description: "触るファイルの glob" }),
  })
  .strict();

/** 親 Issue 1 件。機能のファイル 1 つ */
const IssuePlanParent = z
  .object({
    feature: z.string().regex(FEATURE_NAME).max(100).meta({ description: "詳細設計の機能のファイルの名前 (<番号>-<名前>)" }),
    children: z.array(IssuePlanChild).max(ISSUE_PLAN_CHILDREN_MAX).meta({ description: "要件ごとの子。0 件は、設計書から消えた機能の開いた子を閉じるだけの指定" }),
  })
  .strict();

/** issue_plan の入力。子の合計も 10 件まで */
export const IssuePlanTool = z
  .object({ serviceId: z.uuid(), parents: z.array(IssuePlanParent).min(1).max(ISSUE_PLAN_PARENTS_MAX) })
  .strict()
  .refine((v) => v.parents.reduce((n, p) => n + p.children.length, 0) <= ISSUE_PLAN_CHILDREN_MAX, { message: `子は合わせて ${String(ISSUE_PLAN_CHILDREN_MAX)} 件まで`, path: ["parents"] });

/** issue_plan の入力の型 */
export type IssuePlanTool = z.infer<typeof IssuePlanTool>;
