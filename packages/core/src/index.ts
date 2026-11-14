// ゲートウェイ、社員 DO、ワークスペース、画面が共に使う型と判断を置く
export { systemClock, type Clock } from "./clock.ts";
export { canonicalJson, sha256Hex } from "./hash.ts";
export { allowedFetch, FETCH_TIMEOUT_MS, type Fetcher } from "./fetch.ts";
export { CONTAINER_CA } from "./container.ts";
export { keyedId, newId } from "./id.ts";
export { fromBase64, fromBase64url, toBase64, toBase64url } from "./encoding.ts";
export { deriveKey, type KeyPurpose } from "./keys.ts";
export { log, redact, redactText } from "./log.ts";
export { jstClock, jstDay, jstDayStart, jstYear } from "./time.ts";
export { AppError, ERROR_CODES, PROBLEMS, type FieldError } from "./errors.ts";
export { AuditInput, AuditRow } from "./schemas/audit.ts";
export { StorageUse } from "./schemas/storage.ts";
export { Me, Passkey, PasskeyOptions, PasskeyOptionsInput, Session, StepUp, WebAuthnResponse } from "./schemas/auth.ts";
export { ErrorCode, Health, ListMeta, Meta, Part, Problem } from "./schemas/common.ts";
export { DecideAnswer, DecideInput, Decision, PreToolUseInput } from "./schemas/decision.ts";
export { HeartbeatInput, RunInput, TicketInput, WorkTicketClaims } from "./schemas/workspace.ts";
export { DEFAULT_RULES, decide, type RuleContext, type RuleDecision } from "./rules/decide.ts";
export { OPERATION_KINDS, toOperation, type Operation, type OperationKind } from "./rules/operation.ts";
export {
  AttendanceKind,
  AttendanceReason,
  AttendanceRow,
  CheckpointInput,
  CorrectAttendanceInput,
  DayAttendance,
  DaySummary,
  DEFAULT_SCHEDULE,
  OrderKind,
  StaffId,
  StaffState,
  StaffStatus,
  StaffTask,
  WORKED_KINDS,
  WorkEntry,
  WorkResult,
  WorkSchedule,
} from "./schemas/workday.ts";
export {
  CreateStopInput,
  DEFAULT_THRESHOLDS,
  GuardEvent,
  GuardScope,
  GuardSignal,
  GuardState,
  type Judgment,
  Resumption,
  Stop,
  StopDetail,
  StopPreview,
  StopRow,
  StopTargetInput,
  StopUpdate,
  StopVerdict,
  Thresholds,
  VerdictInput,
} from "./schemas/guard.ts";
export {
  Approval,
  ApprovalKind,
  ApprovalStatus,
  CreateNodeInput,
  DecisionInput,
  Node,
  NodeDetail,
  NodeEvent,
  NodeKind,
  NodeStatus,
  NodeTree,
  OrgStaff,
  PromptVersion,
  TaskKind,
  ToolResult,
  UpdateNodeInput,
  UpdatePromptInput,
} from "./schemas/work.ts";
export {
  DEFAULT_SERVICE_RULES,
  INHERITED_KEYS,
  INHERITED_SETTINGS,
  type InheritedKey,
  OWN_SETTINGS,
  ReleaseCondition,
  RepoAction,
  type ServiceRules,
  Setting,
  UpdateSettingInput,
} from "./schemas/settings.ts";
export { AskBossTool } from "./schemas/tools/ask-boss.ts";
export { AskOwnerTool } from "./schemas/tools/ask-owner.ts";
export { NodeAssignTool } from "./schemas/tools/node-assign.ts";
export { NodeCreateTool } from "./schemas/tools/node-create.ts";
export { PrOpenTool } from "./schemas/tools/pr-open.ts";
export { ReviewSubmitTool } from "./schemas/tools/review-submit.ts";
export { StaffRequestTool } from "./schemas/tools/staff-request.ts";
export {
  type Baseline,
  type Bucket,
  countOffice,
  countStaff,
  emptyOfficeCounts,
  emptyStaffCounts,
  isStaffEvent,
  median,
  OfficeCounts,
  type OfficeEvent,
  resetTask,
  setBaseline,
  STAFF_EVENTS,
  StaffCounts,
  type StaffEvent,
  type TaskCounts,
  taskOverrun,
} from "./guard/signals.ts";

/**
 * 部分ごとの稼働確認の返事を作る
 * @param part 応答した部分
 * @returns 稼働確認の返事
 */
export function health(part: "gate" | "screen" | "workspace"): { ok: true; part: "gate" | "screen" | "workspace" } {
  return { ok: true, part };
}
