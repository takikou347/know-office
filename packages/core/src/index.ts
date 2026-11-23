// ゲートウェイ、社員 DO、ワークスペース、画面が共に使う型と判断を置く
export { systemClock, type Clock } from "./clock.ts";
export { canonicalJson, sha256Hex } from "./hash.ts";
export { allowedFetch, FETCH_TIMEOUT_MS, type Fetcher } from "./fetch.ts";
export { cloudflareMonthMicroUsd, WORKERS_PAID_MICRO_USD } from "./cloudflare.ts";
export { allowedModels, batchCostMicroUsd, type ClaudeModel, claudeSpendLimit, type ClaudeSpendLimit, type ClaudeUsage, costMicroUsd, dailyAllowanceMicroUsd, DEV_STAFF_HEADER, HAIKU, isPricier, isStaffModel, JOB_MODEL, OPUS, SONNET, SELECTABLE_MODELS } from "./claude.ts";
export { ClaudeBudget, ClaudeErrorBody, DEFAULT_CLAUDE_BUDGET, SPEND_LIMIT_KINDS, type SpendLimitKind } from "./schemas/claude.ts";
export { Secret } from "./secret.ts";
export { CONTAINER_CA, WORKSPACE_KEY_ENV } from "./container.ts";
export { keyedId, newId } from "./id.ts";
export { fromBase64, fromBase64url, toBase64, toBase64url } from "./encoding.ts";
export { deriveKey, type KeyPurpose } from "./keys.ts";
export { log, redact, redactPublic, redactText } from "./log.ts";
export { jstClock, jstDay, jstDayStart, jstYear } from "./time.ts";
export { AppError, ERROR_CODES, PROBLEMS, type FieldError } from "./errors.ts";
export { AuditInput, AuditRow, AuditVerification, VerifyAuditInput } from "./schemas/audit.ts";
export { ERROR_SOURCES, ErrorEvent, ErrorEventCode, Trace, TraceId } from "./schemas/trace.ts";
export { Notice, NoticeLevel, NoticeLink } from "./schemas/notices.ts";
export { AnalyticsEngineTables, AnalyticsEngineVisits, VISIT_HEADER, VisitHeader, WorkersInvocationsResponse } from "./schemas/analytics.ts";
export { codePoints, CreateMessageInput, headChars, LiveEvent, LiveTicket, Message, MessageDelivery, MessageOrder, MESSAGE_INLINE_CHARS, MESSAGE_MAX_CHARS, OFFICE_WORK_ACTIONS, OfficeWork, type OwnerMessage, ownerMessagesPrompt, SkippedOrder } from "./schemas/conversation.ts";
export { StorageUse } from "./schemas/storage.ts";
export { AttendanceQuery, CostHistory, CostMonth, DailyCost, Dashboard, HomeService, Month, OwnerReview, RecordGroup, RecordSummary, RecordTotals, Uptime, UptimeQuery } from "./schemas/records.ts";
export { Me, Passkey, PasskeyOptions, PasskeyOptionsInput, Session, StepUp, WebAuthnResponse } from "./schemas/auth.ts";
export { CreatedMcpClient, CreateMcpClientInput, McpClient, McpDecideArgs, McpMessageArgs, McpNoArgs, McpRequest, McpResponse, McpScope, McpTaskArgs } from "./schemas/mcp.ts";
export { ErrorCode, Health, ListMeta, Meta, Part, Problem } from "./schemas/common.ts";
export { DecideAnswer, DecideInput, Decision, PreToolUseInput } from "./schemas/decision.ts";
export {
  AGENT_EVENTS_MAX,
  AgentEvent,
  AgentEventsInput,
  EXTENSION_TOOL_NAME,
  EXTENSION_TOOLS_MAX,
  ExtensionToolSpec,
  extensionToolShape,
  HeartbeatInput,
  LSP_TREE_BYTES,
  LspTreeParams,
  ReasonInput,
  RESTORE_BODY_BYTES,
  RESTORE_TRANSCRIPT_BYTES,
  RestoreInput,
  RunInput,
  TicketInput,
  TRANSCRIPT_PART_BYTES,
  TranscriptPartInput,
  WorkspaceMessageInput,
  WorkTicketClaims,
} from "./schemas/workspace.ts";
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
  GitHubIssueCreated,
  GitHubIssueList,
  GitHubWebhookHead,
  GitHubDeploymentStatusEvent,
  GitHubPushEvent,
  GitHubWorkflowRunEvent,
  PackageManifest,
  PackageName,
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
  GitHubPullState,
  GitHubRef,
  GitHubRepo,
  GitHubRules,
  GitHubLink,
  GitHubRulesApplied,
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
  MirrorIssueClosePayload,
  MirrorStatusPayload,
  OWNER_APPROVAL_CONTEXT,
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
  ChatOrders,
  CheckpointInput,
  CorrectAttendanceInput,
  DayAttendance,
  DaySummary,
  DEFAULT_CHAT_ORDERS,
  DEFAULT_OFF_HOURS_CALL,
  DEFAULT_SCHEDULE,
  CreateOrderInput,
  CreateStaffInput,
  UpdateStaffInput,
  OffHoursCall,
  Order,
  OrderKind,
  StaffId,
  StaffJob,
  StaffOverview,
  StaffState,
  StaffStatus,
  StaffTask,
  WORKED_KINDS,
  WorkEntry,
  WorkResult,
  WorkSchedule,
} from "./schemas/workday.ts";
export { checkServiceDocs, isRedactedName, requirementsOf, DOCS_REPO_KEY, SERVICE_NAME, type DocsProblem, DocsRepo, DocsRepoValue, docsMergeNeeds, serviceDirs, UpdateDocsRepoInput } from "./devloop/docs.ts";
export { Finding, FindingAnswer, FindingEffect, FindingKind, FindingNeeds, FindingStatus, Fingerprint } from "./schemas/findings.ts";
export {
  CreateStopInput,
  DEFAULT_GUARD_REVIEW,
  DEFAULT_THRESHOLDS,
  DistillAnswer,
  GuardEffect,
  GuardEvent,
  GuardReview,
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
  ReviewAnswer,
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
  APPROVAL_KIND_LABEL,
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
  compareSemver,
  CreateIdeaInput,
  UpdateServiceInput,
  IdeaProposal,
  IdeasAnswer,
  DeployDetail,
  Deployment,
  ReleaseDetail,
  RollbackDetail,
  SERVICE_EVENT_KINDS,
  UsesDetail,
  NEXT_STAGES,
  RollbackInput,
  Semver,
  ServiceCard,
  ServiceDetail,
  ServiceDocsPr,
  ServiceIssueChild,
  ServiceIssueParent,
  ServiceIssues,
  ServiceKind,
  ServiceStage,
  ServiceStatus,
} from "./schemas/services.ts";
export { EXTENSION_ID, EXTENSION_TOOL, Extension, ToggleExtensionInput } from "./schemas/extensions.ts";
export { DeskSeat, ExtensionRoomDef, FLOOR_KINDS, type FloorKind, Furniture, FURNITURE_KINDS, type FurnitureKind, type Point, ROOM_FURNITURE_MAX, ROOM_NAME_MAX, ROOM_SIZE_MAX, RoomDef, RoomPoint, RoomSpot, type Spot } from "./schemas/office-rooms.ts";
export { AskBossTool } from "./schemas/tools/ask-boss.ts";
export { AskOwnerTool } from "./schemas/tools/ask-owner.ts";
export { IdeaAddTool } from "./schemas/tools/idea-add.ts";
export { ServiceCloseRequestTool } from "./schemas/tools/service-close-request.ts";
export { devIssueKey, devIssueText, type DevIssueKind, type DevIssueSource, featureTitle, ISSUE_KINDS, ISSUE_LABELS, type IssueKind, type IssueLabel, parseRequirements } from "./devloop/issues.ts";
export { globHead, globsOverlap, hasTestFile } from "./devloop/glob.ts";
export { FEATURE_NAME, ISSUE_PLAN_CHILDREN_MAX, ISSUE_PLAN_PARENTS_MAX, IssuePlanTool } from "./schemas/tools/issue-plan.ts";
export { StudySubmitTool } from "./schemas/tools/study-submit.ts";
export { NodeAssignTool } from "./schemas/tools/node-assign.ts";
export { NodeCreateTool } from "./schemas/tools/node-create.ts";
export { PrOpenTool } from "./schemas/tools/pr-open.ts";
export { DocsPrOpenTool } from "./schemas/tools/docs-pr-open.ts";
export { ReviewSubmitTool } from "./schemas/tools/review-submit.ts";
export { StaffRequestTool } from "./schemas/tools/staff-request.ts";
export { CheckpointTool } from "./schemas/tools/checkpoint.ts";
export { ReportTool } from "./schemas/tools/report.ts";
export { OWNER_INFO_ITEM, OwnerInfoReadTool } from "./schemas/tools/owner-info-read.ts";
export { ORG_RULES } from "./rules/org-rules.ts";
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
