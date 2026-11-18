// 社員のツールを MCP の受け手に出す時の説明と入力の形。中身と正本の入力の確かめはゲートウェイが持つ (社員が考えるの 3.6、タスクとレビューの 2 章)
import type { StaffToolName } from "../../rules/staff-tools.ts";
import { StaffId } from "../workday.ts";
import { z } from "../zod.ts";
import { AskBossTool } from "./ask-boss.ts";
import { AskOwnerTool } from "./ask-owner.ts";
import { DocsPrOpenTool } from "./docs-pr-open.ts";
import { CheckpointTool } from "./checkpoint.ts";
import { IdeaAddTool } from "./idea-add.ts";
import { IssuePlanTool } from "./issue-plan.ts";
import { NodeAssignTool } from "./node-assign.ts";
import { NodeCreateTool } from "./node-create.ts";
import { OwnerInfoReadTool } from "./owner-info-read.ts";
import { PrOpenTool } from "./pr-open.ts";
import { ReportTool } from "./report.ts";
import { ReviewSubmitTool } from "./review-submit.ts";
import { ServiceCloseRequestTool } from "./service-close-request.ts";
import { StudySubmitTool } from "./study-submit.ts";

/** MCP の受け手に出す 1 つのツール。shape は SDK の tool() が受ける項目ごとの Zod */
export type StaffToolEntry = {
  /** 社員に見せる説明 */
  description: string;
  /** 入力の項目ごとの Zod */
  shape: Record<string, z.ZodType>;
};

// staff_request の正本は kind で分けた共用体で、SDK は項目ごとの形しか受けないので、平らにした形を見せる。分けた形はゲートウェイが確かめる
const STAFF_REQUEST_SHAPE = {
  kind: z.enum(["staff_add", "role_change"]).describe("staff_add は社員の追加、role_change は役の変更"),
  role: z.string().min(1).max(100).describe("足す社員か、変えた後の役"),
  bossId: StaffId.nullable().describe("上司の社員 ID。role_change で上司を外す時は null"),
  target: StaffId.optional().describe("role_change の時だけ、役を変える社員 ID"),
  reason: z.string().min(1).max(2000),
};

/** 社員のツールの説明と入力の形。名前を足すと型のチェックがここへの書き足しを求める */
export const STAFF_TOOL_CATALOG: Record<StaffToolName, StaffToolEntry> = {
  node_create: { description: "目標の下にプロジェクトを、プロジェクトの下にタスクを作る。assignee を付けるとその社員に割り振る", shape: NodeCreateTool.shape },
  node_assign: { description: "タスクを社員に割り振る", shape: NodeAssignTool.shape },
  staff_request: { description: "社員の追加か役の変更をオーナーに求める。今のタスクはオーナーの答えを待ち、答えが出るまで社員は変わらない", shape: STAFF_REQUEST_SHAPE },
  study_submit: { description: "検討の段階の案を調べた材料を出す。オーナーが読んで進めるかを決める", shape: StudySubmitTool.shape },
  issue_plan: { description: "設計書の機能ごとの親と要件ごとの子の組を送り、サービスのリポジトリに Issue を作る。題と本文はゲートウェイが決まった形で作る。Issue を合わせるタスクで呼ぶ", shape: IssuePlanTool.shape },
  service_close_request: { description: "サービスを閉じる案をオーナーに出す。オーナーが承認するまでサービスは閉じない", shape: ServiceCloseRequestTool.shape },
  docs_pr_open: { description: "仕様が変わった時に、設計書のリポジトリへ ko/<タスク ID の頭 8 字>-<name> から PR を出す。タスクは作業中のまま。出した番号を pr_open の docsPr に書いてコードの PR に結ぶ", shape: DocsPrOpenTool.shape },
  pr_open: { description: "今のタスクのブランチ (タスクを取った時に決まった ko/<タスク ID>) からプルリクエストを出す。出すとタスクはレビューを待つ。差し戻しの後に直して呼ぶと、同じプルリクエストでもう一度レビューを求める。仕様が変わったなら docs_pr_open で出した設計書の PR の番号を docsPr に書く", shape: PrOpenTool.shape },
  review_submit: { description: "今のレビューのタスクに承認か差し戻しを出す。差し戻しは理由と一緒に作った社員に戻る", shape: ReviewSubmitTool.shape },
  idea_add: { description: "サービスの案を足す。オーナーの案と同じくアイデアの段階に並ぶ", shape: IdeaAddTool.shape },
  ask_boss: { description: "上司に次のタスクを求めるか、困った事を上げる", shape: AskBossTool.shape },
  ask_owner: { description: "費用が増える事か新しい外部連携をオーナーに上げる。今のタスクはオーナーの答えを待つ", shape: AskOwnerTool.shape },
  checkpoint: { description: "テストが通った、コミットした、プルリクエストを出した、経過を書き残した事を伝える。区切りごとに呼ぶ", shape: CheckpointTool.shape },
  report: { description: "オーナーに伝える事を発言する。オーナーの画面の会話に出る", shape: ReportTool.shape },
  owner_info_read: { description: "ルールで許したオーナーの情報の 1 項目を読む。読んだ事は記録に残り、外部の文章を読んだタスクでは断られる", shape: OwnerInfoReadTool.shape },
};
