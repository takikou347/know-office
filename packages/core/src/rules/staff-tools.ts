// 社員のツールの名前と、役ごとに使えるツール (社員が考えるの 3.5、タスクとレビューの 2 章)

/** ゲートウェイが中身を持つ社員のツールの名前。SDK には mcp__staff__<名前> で届く */
export const STAFF_TOOL_NAMES = [
  "node_create",
  "node_assign",
  "staff_request",
  "study_submit",
  "issue_plan",
  "service_close_request",
  "pr_open",
  "docs_pr_open",
  "review_submit",
  "idea_add",
  "ask_boss",
  "ask_owner",
  "checkpoint",
  "report",
  "owner_info_read",
] as const;

/** 社員のツールの名前。`STAFF_TOOL_NAMES` の 1 つ */
export type StaffToolName = (typeof STAFF_TOOL_NAMES)[number];

/** 職種ごとに使える社員のツール。ここに無いツールはルールの判断が断り、ゲートウェイも not_found で断る */
export const ROLE_TOOLS = {
  president: ["node_create", "node_assign", "staff_request", "study_submit", "issue_plan", "idea_add", "service_close_request", "ask_boss", "ask_owner", "checkpoint", "report", "owner_info_read"],
  builder: ["pr_open", "docs_pr_open", "idea_add", "service_close_request", "ask_boss", "ask_owner", "checkpoint", "report", "owner_info_read"],
  reviewer: ["review_submit", "idea_add", "ask_boss", "ask_owner", "checkpoint", "report", "owner_info_read"],
} as const satisfies Record<"president" | "builder" | "reviewer", readonly StaffToolName[]>;

/**
 * 名前が社員のツールかを確かめる
 * @param name ツールの名前 (mcp__staff__ を外した物)
 * @returns 社員のツールなら true
 */
export function isStaffTool(name: string): name is StaffToolName {
  return (STAFF_TOOL_NAMES as readonly string[]).includes(name);
}
