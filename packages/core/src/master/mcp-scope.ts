// MCP の連携の鍵でできる事の範囲 (ログインと記録の 3.10)
import { defineMaster } from "./master.ts";

/** MCP の連携の鍵の範囲。read は読むだけ、write は承認と社員への発言も */
export const MCP_SCOPES = defineMaster([
  { value: "read", label: "読むだけ", note: "社員、タスク、ホーム、承認待ちを読む" },
  { value: "write", label: "承認と発言も", note: "パスキーの要らない承認と、社員への発言も出す" },
]);
