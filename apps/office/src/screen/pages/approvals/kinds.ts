// 承認の種類ごとの、見出し、説明、決める所。ゲートウェイが承認を受ける種類と、ほかの画面で決める種類を分ける (タスクとレビューの 3.1)
import { APPROVAL_KIND_LABEL, type Approval, type ApprovalKind, StaffId } from "@know-office/core";
import { z } from "zod";
import { staffLabel } from "../guard/labels.ts";

/** 承認の種類ごとの、オーナーに出す説明。承認すると何が起きるかを書く */
export const KIND_NOTE: Record<ApprovalKind, string> = {
  staff_add: "承認しても社員は増えません。足す時は社員の画面の「社員を追加」から足します。承認した事は記録に残り、社員に返ります。",
  role_change: "承認すると、その社員の役と上司が変わります。",
  prompt_rule: "説明文の決まりは、守りの画面の蒸留した学びで決めます。",
  external_integration: "承認する前にパスキーで確かめます。承認しても know-office は外へ送らず、承認した事を社員に返します。",
  cost_increase: "承認する前にパスキーで確かめます。承認しても know-office はお金を動かさず、承認した事を社員に返します。",
  merge: "main へのマージは、社員と仕事のレビューで決めます。",
  deploy: "デプロイの承認は、まだ決める所がありません。",
  service_close: "承認すると、サービスを閉じます。",
  guard_change: "守りの変更は、守りの画面で決めます。",
};

/** 決める所。here はこの画面、review と guard はほかの画面、none は決める所がまだ無い */
export type DecidePlace = "here" | "review" | "guard" | "none";

/** 承認の種類ごとの、決める所 */
export const KIND_PLACE: Record<ApprovalKind, DecidePlace> = {
  staff_add: "here",
  role_change: "here",
  prompt_rule: "guard",
  external_integration: "here",
  cost_increase: "here",
  merge: "review",
  deploy: "none",
  service_close: "here",
  guard_change: "guard",
};

/** 承認する前にパスキーで確かめる種類。ゲートウェイと同じ */
export const STEP_UP_KINDS: ReadonlySet<ApprovalKind> = new Set(["external_integration", "cost_increase"]);

const Waiting = z.object({ nodeId: z.uuid() }).loose();
const RoleChange = z.object({ role: z.string(), bossId: StaffId.nullable() }).loose();
const Reason = z.object({ reason: z.string() }).loose();

/**
 * 承認の見出し。種類と対象。役の変更の対象は社員の名前にする
 * @param a 承認
 * @returns 見出し
 */
export function approvalTitle(a: Pick<Approval, "kind" | "target">): string {
  const staff = StaffId.safeParse(a.target);
  const target = a.kind === "role_change" && staff.success ? staffLabel(staff.data) : a.target;
  return `${APPROVAL_KIND_LABEL[a.kind]}: ${target}`;
}

/**
 * 求めた社員の名前。知らない社員は ID のまま出す
 * @param requestedBy 求めた社員の ID
 * @returns 名前
 */
export function requesterName(requestedBy: string): string {
  const staff = StaffId.safeParse(requestedBy);
  return staff.success ? staffLabel(staff.data) : requestedBy;
}

/**
 * 承認の中身のうち、オーナーが決めるのに読む所。役の変更は新しい役と上司、ほかは社員の書いた理由
 * @param a 承認
 * @returns 読む文の並び
 */
export function approvalDetails(a: Pick<Approval, "kind" | "payload">): string[] {
  const lines: string[] = [];
  const role = RoleChange.safeParse(a.payload);
  if (a.kind === "role_change" && role.success) lines.push(`新しい役: ${role.data.role}、上司: ${role.data.bossId === null ? "無し" : staffLabel(role.data.bossId)}`);
  const reason = Reason.safeParse(a.payload);
  if (reason.success) lines.push(`理由: ${reason.data.reason}`);
  return lines;
}

/**
 * ほかの画面で決める種類の、決める所への道。中身の文字列は使わず、確かめた社員 ID とタスク ID と決まった道だけから組む
 * @param a 承認
 * @returns 道。決める所がまだ無いか、組めなければ null
 */
export function decideHref(a: Pick<Approval, "kind" | "payload" | "requestedBy">): string | null {
  const place = KIND_PLACE[a.kind];
  if (place === "guard") return "/guard";
  if (place !== "review") return null;
  const waiting = Waiting.safeParse(a.payload);
  const staff = StaffId.safeParse(a.requestedBy);
  return waiting.success && staff.success ? `/staff/${staff.data}/tasks/${waiting.data.nodeId}` : null;
}

/** 決める所への道の文 */
export const PLACE_LINK: Record<"review" | "guard", string> = { review: "社員と仕事のレビューで決める", guard: "守りの画面で決める" };
