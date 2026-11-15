// ゲートウェイ、社員 DO、ワークスペース、画面が共に使う型と判断を置く
export { systemClock, type Clock } from "./clock.ts";
export { canonicalJson, sha256Hex } from "./hash.ts";
export { allowedFetch, FETCH_TIMEOUT_MS, type Fetcher } from "./fetch.ts";
export { allowedModels, batchCostMicroUsd, type ClaudeModel, type ClaudeUsage, costMicroUsd, HAIKU, OPUS, SONNET } from "./claude.ts";
export { Secret } from "./secret.ts";
export { CONTAINER_CA, WORKSPACE_KEY_ENV } from "./container.ts";
export { keyedId, newId } from "./id.ts";
export { fromBase64, fromBase64url, toBase64, toBase64url } from "./encoding.ts";
export { deriveKey, type KeyPurpose } from "./keys.ts";
export { log, redact, redactPublic, redactText } from "./log.ts";
export { jstClock, jstDay, jstDayStart, jstYear } from "./time.ts";
export { AppError, ERROR_CODES, PROBLEMS, type FieldError } from "./errors.ts";
export { AuditInput, AuditRow, AuditVerification, VerifyAuditInput } from "./schemas/audit.ts";
export { Notice, NoticeLevel } from "./schemas/notices.ts";
export { StorageUse } from "./schemas/storage.ts";
export { RecordGroup, RecordSummary, RecordTotals } from "./schemas/records.ts";
export { Me, Passkey, PasskeyOptions, PasskeyOptionsInput, Session, StepUp, WebAuthnResponse } from "./schemas/auth.ts";
export { ErrorCode, Health, ListMeta, Meta, Part, Problem } from "./schemas/common.ts";
export { DecideAnswer, DecideInput, Decision, PreToolUseInput } from "./schemas/decision.ts";
export { HeartbeatInput, RESTORE_BODY_BYTES, RESTORE_TRANSCRIPT_BYTES, RestoreInput, RunInput, TicketInput, TRANSCRIPT_PART_BYTES, TranscriptPartInput, WorkTicketClaims } from "./schemas/workspace.ts";
export { DEFAULT_RULES, decide, type RuleContext, type RuleDecision } from "./rules/decide.ts";
export { isStaffTool, ROLE_TOOLS, STAFF_TOOL_NAMES, type StaffToolName } from "./rules/staff-tools.ts";
export { decideRepo, mainRuleset, missingConditions, OWNER_GUARDED_PATHS, ownerGuardedPath, type RepoDecision, type RepoRequest, type RepoScope, RULESET_NAME, type RulesetBody } from "./rules/repo.ts";
export {
  AppSlug,
  CheckRunEvent,
  CheckSuiteEvent,
  DeliveryId,
  GitHubAccessToken,
  GitHubAppConversion,
  GitHubAppKeys,
  GitHubCallbackQuery,
  GitHubEventName,
  GitHubId,
  GitHubInstallation,
  GitHubInstallationKey,
  GitHubInstallationRepos,
  GitHubInstalledQuery,
  GitHubGitCommit,
  GitHubGitObject,
  GitHubGitTree,
  GitHubManifest,
  GitHubPosted,
  GitHubPostedList,
  GitHubWebhookHead,
  HubSignature,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
  Repo,
  GitHubCheckRuns,
  GitHubCompare,
  GitHubContent,
  GitHubPullFiles,
  GitHubPull,
  GitHubRef,
  GitHubRepo,
  GitHubRules,
  GitHubRulesValue,
  GitHubRuleset,
  GitHubRulesets,
  RepoName,
  UpdateGitHubRulesInput,
} from "./schemas/github.ts";
export {
  Commit,
  CommitSha,
  CreateCommitInput,
  CreateNoteInput,
  FileContent,
  FileDiff,
  languageOfPath,
  MirrorCommentPayload,
  MirrorReviewPayload,
  NoteSide,
  OwnerVerdict,
  RepoPath,
  ReviewDiffQuery,
  ReviewFileQuery,
  ReviewFileStatus,
  ReviewHead,
  ReviewNote,
  ReviewVerdict,
  ReviewVerdictInput,
  SeenInput,
} from "./schemas/review.ts";
export { MAX_RECORDED, maskSecrets, OPERATION_KINDS, recordedText, SECRET_SHAPES, type SecretShape, toOperation, type Operation, type OperationKind } from "./rules/operation.ts";
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
export { Finding, FindingAnswer, FindingEffect, FindingKind, FindingNeeds, FindingStatus, Fingerprint } from "./schemas/findings.ts";
export {
  CreateStopInput,
  DEFAULT_THRESHOLDS,
  DistillAnswer,
  GuardEffect,
  GuardEvent,
  GuardScope,
  GuardSignal,
  GuardKeys,
  GuardState,
  GuardThresholds,
  type Judgment,
  KeyKind,
  Lesson,
  LessonKind,
  LessonStatus,
  ReplaceClaudeKeyInput,
  ReplaceGitHubAppKeyInput,
  Resumption,
  Stop,
  StopDetail,
  StopPreview,
  StopRow,
  StopTargetInput,
  StopUpdate,
  StopVerdict,
  Thresholds,
  UpdateThresholdsInput,
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
  TOOL_NAME,
  TOOL_NAME_MAX,
  ToolCallAnswer,
  ToolCallInput,
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
  weakens,
} from "./schemas/settings.ts";
export {
  AdvanceInput,
  AdvanceStage,
  CLOSABLE_STAGES,
  CreateIdeaInput,
  NEXT_STAGES,
  ServiceCard,
  ServiceDetail,
  ServiceKind,
  ServiceStage,
} from "./schemas/services.ts";
export { EXTENSION_ID, EXTENSION_TOOL, Extension, ToggleExtensionInput } from "./schemas/extensions.ts";
export { AskBossTool } from "./schemas/tools/ask-boss.ts";
export { AskOwnerTool } from "./schemas/tools/ask-owner.ts";
export { IdeaAddTool } from "./schemas/tools/idea-add.ts";
export { ServiceCloseRequestTool } from "./schemas/tools/service-close-request.ts";
export { StudySubmitTool } from "./schemas/tools/study-submit.ts";
export { NodeAssignTool } from "./schemas/tools/node-assign.ts";
export { NodeCreateTool } from "./schemas/tools/node-create.ts";
export { PrOpenTool } from "./schemas/tools/pr-open.ts";
export { ReviewSubmitTool } from "./schemas/tools/review-submit.ts";
export { StaffRequestTool } from "./schemas/tools/staff-request.ts";
export { STAFF_TOOL_CATALOG, type StaffToolEntry } from "./schemas/tools/catalog.ts";
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
