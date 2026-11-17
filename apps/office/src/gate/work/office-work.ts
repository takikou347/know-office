// タスクの出来事から、オフィスで見せる仕事の出来事 (渡す、レビューを頼む、承認、差し戻し) を決める (画面の全体の 3.2、社員が考えるの 3.8)
import { type Clock, type OfficeWork, StaffId } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { nodes } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { announce } from "../live/publish.ts";

/** レビューを受け持つ社員 */
const REVIEWER: StaffId = "reviewer";

/** 出来事を決めるのに使うタスクの項目 */
export type WorkRow = Pick<typeof nodes.$inferSelect, "id" | "kind" | "title" | "assignee" | "taskKind">;

/** 出来事を決めるのに使う、タスクの出来事の項目 */
export type WorkCause = {
  /** 出来事の種類 (created、updated、pr_opened など) */
  kind: string;
  /** 起こした社員。オーナーとゲートウェイは null */
  staffId: string | null;
  /** 頼む先を替えた時の、前と後の担当。updated の時だけ呼ぶ側が渡す */
  assigned?: { from: string | null; to: string | null } | undefined;
};

/**
 * 起こした者をオフィスの出来事の側にする。社員でない者 (オーナー、ゲートウェイ、GitHub で出した判断) はオーナーにする
 * @param staffId 起こした社員か null
 * @returns 社員 ID か owner
 */
function sideOf(staffId: string | null): OfficeWork["from"] {
  const staff = StaffId.safeParse(staffId);
  return staff.success ? staff.data : "owner";
}

/**
 * 担当を社員 ID として読む。担当の無いタスクと知らない担当は null
 * @param assignee 担当
 * @returns 社員 ID か null
 */
function staffOf(assignee: string | null | undefined): StaffId | null {
  const staff = StaffId.safeParse(assignee);
  return staff.success ? staff.data : null;
}

/**
 * タスクの出来事から、オフィスで見せる仕事の出来事を決める。見せない出来事と、相手の決まらない出来事は null
 * @param cause タスクの出来事
 * @param row 出来事の後のタスクの行
 * @returns 仕事の出来事か null
 */
export function officeWorkOf(cause: WorkCause, row: WorkRow): OfficeWork | null {
  if (row.kind !== "task") return null;
  const base = { nodeId: row.id, title: row.title };
  const from = sideOf(cause.staffId);
  const maker = staffOf(row.assignee);
  switch (cause.kind) {
    case "created": {
      // レビューのタスクはプルリクエストを出した時にゲートウェイが作るので、頼んだ印 (pr_opened) で見せ、渡す出来事にしない
      if (row.taskKind === "review" || maker === null) return null;
      return { ...base, action: "assign", from, to: maker };
    }
    case "updated": {
      const to = staffOf(cause.assigned?.to);
      const handedOver = to !== null && cause.assigned?.from !== to;
      return handedOver ? { ...base, action: "assign", from, to } : null;
    }
    case "pr_opened":
      return { ...base, action: "review-request", from, to: REVIEWER };
    case "review_approved":
    case "owner_approved":
      return maker === null ? null : { ...base, action: "approve", from, to: maker };
    case "review_rejected":
      return maker === null ? null : { ...base, action: "send-back", from, to: maker };
    default:
      return null;
  }
}

/** オフィスで見せる出来事になり得る種類。ほかの出来事ではタスクを読み直さない */
const WORK_KINDS: ReadonlySet<string> = new Set(["created", "updated", "pr_opened", "review_approved", "owner_approved", "review_rejected"]);

/**
 * オフィスで見せる出来事なら、タスクを読み直して仕事の出来事を配る。出来事は書けた後なので、読めない時と配れない時はエラーログに残すだけで投げない
 * @param env バインディング
 * @param cause タスクの出来事
 * @param clock 時刻
 */
export async function announceWork(env: Bindings, cause: WorkCause & { nodeId: string }, clock: Clock): Promise<void> {
  if (!WORK_KINDS.has(cause.kind)) return;
  try {
    const [row] = await drizzle(env.DB).select().from(nodes).where(eq(nodes.id, cause.nodeId)).limit(1);
    if (!row) throw new Error("出来事のタスクが無い");
    const work = officeWorkOf(cause, row);
    if (work !== null) await announce(env, { type: "work", work }, clock);
  } catch (error) {
    await recordError(env, { source: "live_do", level: "warn", code: "live_publish_failed", error }, clock);
  }
}
