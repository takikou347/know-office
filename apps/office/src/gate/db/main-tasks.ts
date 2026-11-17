// D1 の DB のうち、タスク、承認、レビュー、GitHub、サービス、設定、通知、拡張のテーブル。データの 2 章 と 2.6
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, json, time } from "./columns.ts";

// 2.5 タスク、承認、レビュー、GitHub

/** 目的、目標、プロジェクト、タスクの木 */
export const nodes = sqliteTable(
  "nodes",
  {
    id: id(),
    kind: text("kind", { enum: ["purpose", "goal", "project", "task"] }).notNull(),
    parentId: text("parent_id"),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    taskKind: text("task_kind", { enum: ["build", "content", "fix", "plan", "review"] }),
    assignee: text("assignee"),
    status: text("status", { enum: ["todo", "doing", "review", "done", "stopped", "waiting_owner", "dropped"] }).notNull(),
    priority: integer("priority").notNull(),
    repo: text("repo"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    issueNumber: integer("issue_number"),
    source: text("source"),
    progress: json("progress"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [index("nodes_parent").on(t.parentId), index("nodes_assignee_status").on(t.assignee, t.status)],
);

/** オーナーの承認 */
export const approvals = sqliteTable("approvals", {
  id: id(),
  kind: text("kind", {
    enum: ["staff_add", "role_change", "prompt_rule", "external_integration", "cost_increase", "merge", "deploy", "service_close", "guard_change"],
  }).notNull(),
  target: text("target").notNull(),
  payload: json("payload"),
  status: text("status").notNull(),
  requestedBy: text("requested_by").notNull(),
  requestedAt: time("requested_at").notNull(),
  decidedAt: time("decided_at"),
  reason: text("reason"),
});

/** レビュー */
export const reviews = sqliteTable("reviews", {
  id: id(),
  nodeId: text("node_id").notNull(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  branch: text("branch").notNull(),
  baseSha: text("base_sha").notNull(),
  headSha: text("head_sha").notNull(),
  lastSeenSha: text("last_seen_sha"),
  checks: json("checks"),
  reviewerSummary: text("reviewer_summary"),
  reviewerVerdict: text("reviewer_verdict"),
  ownerVerdict: text("owner_verdict"),
});

/** レビューの書き込み。追記専用 */
export const reviewNotes = sqliteTable("review_notes", {
  id: id(),
  reviewId: text("review_id").notNull(),
  at: time("at").notNull(),
  by: text("by").notNull(),
  path: text("path").notNull(),
  line: integer("line").notNull(),
  side: text("side").notNull(),
  body: text("body").notNull(),
  githubCommentId: integer("github_comment_id"),
});

/**
 * know-office の中のレビューを GitHub のプルリクエストに写す順番待ち。承認と差し戻しはレビュー、指摘は行のコメントとして送る
 * 送れたら github_id と sent_at を置く。送れない間は attempts を数え、5 分ごとの定期ジョブが送り直す。claimed_until は送る者を 1 つにする印
 */
export const githubMirrors = sqliteTable(
  "github_mirrors",
  {
    id: id(),
    reviewId: text("review_id").notNull(),
    kind: text("kind", { enum: ["review", "comment", "status"] }).notNull(),
    payload: json("payload").notNull(),
    createdAt: time("created_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    claimedUntil: time("claimed_until"),
    githubId: integer("github_id"),
    sentAt: time("sent_at"),
  },
  (t) => [index("github_mirrors_pending").on(t.sentAt, t.id)],
);

/** 受けた GitHub の通知。送り直しは配信 ID が変わるので、本文の SHA-256 で同じ通知を 2 度受けない */
export const githubDeliveries = sqliteTable("github_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  bodySha256: text("body_sha256").notNull().unique(),
  event: text("event").notNull(),
  receivedAt: time("received_at").notNull(),
});

/** GitHub App を作りに出した state の使い捨ての値。callback で 1 度だけ消せる */
export const githubStates = sqliteTable("github_states", {
  nonce: text("nonce").primaryKey(),
  createdAt: time("created_at").notNull(),
  expiresAt: time("expires_at").notNull(),
});

/** 同じ時に 1 つだけ動かす操作の錠。holder が取った者、until を過ぎた錠はほかが取り直せる */
export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  until: time("until").notNull(),
});

// 2.6 サービス、設定、通知、拡張

/** サービス */
export const services = sqliteTable("services", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["library", "web_app", "content"] }).notNull(),
  stage: text("stage", { enum: ["idea", "study", "prototype", "service", "operation", "dropped", "closed"] }).notNull(),
  ideaId: text("idea_id"),
  repo: text("repo"),
  staffId: text("staff_id"),
  aim: text("aim"),
  users: text("users"),
  costEstimate: integer("cost_estimate"),
  revenueEstimate: integer("revenue_estimate"),
  studyKey: text("study_key"),
  droppedReason: text("dropped_reason"),
  createdAt: time("created_at").notNull(),
});

/** サービスの出来事。追記専用 */
export const serviceEvents = sqliteTable("service_events", {
  id: id(),
  at: time("at").notNull(),
  serviceId: text("service_id").notNull(),
  kind: text("kind", { enum: ["stage", "deploy", "rollback", "release", "uses"] }).notNull(),
  by: text("by").notNull(),
  detail: json("detail"),
});

/** office の設定。キーと範囲ごとに最新の行が今の値。追記専用 */
export const settings = sqliteTable(
  "settings",
  {
    id: id(),
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    value: json("value"),
    version: integer("version").notNull(),
    changedBy: text("changed_by").notNull(),
    reason: text("reason"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [index("settings_key_scope").on(t.key, t.scope, t.version)],
);

/** サービスの設定。null は初期値に戻す。追記専用 */
export const serviceSettings = sqliteTable("service_settings", {
  id: id(),
  serviceId: text("service_id").notNull(),
  key: text("key").notNull(),
  value: json("value"),
  version: integer("version").notNull(),
  by: text("by").notNull(),
  createdAt: time("created_at").notNull(),
});

/** 画面に出す知らせ */
export const notices = sqliteTable("notices", {
  id: id(),
  at: time("at").notNull(),
  level: text("level", { enum: ["info", "warn", "stop"] }).notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  scope: text("scope").notNull(),
  readAt: time("read_at"),
  /** 画面の中の開く先。無ければ null */
  link: text("link"),
});

/** アプリが見つけた直す所 */
export const findings = sqliteTable("findings", {
  id: id(),
  fingerprint: text("fingerprint").notNull().unique(),
  repo: text("repo"),
  issueNumber: integer("issue_number"),
  kind: text("kind", { enum: ["error", "slow", "cost"] }).notNull(),
  count: integer("count").notNull(),
  firstAt: time("first_at").notNull(),
  lastAt: time("last_at").notNull(),
  status: text("status").notNull(),
  fixedAt: time("fixed_at"),
  effect: json("effect"),
  claimedAt: time("claimed_at"),
  /** 効き目を Issue に書いた (書いている) 時刻。書けなければ NULL に戻し、次の回に書き直す */
  notedAt: time("noted_at"),
});

/**
 * 送った Claude のバッチ処理。種類と週ごとに 1 行で、同じ週を 2 度送らない。
 * status は pending (送る途中)、submitted (送った)、applied (結果を入れた)、unknown (送ったか分からないので送り直さない)、failed (終わらないので諦めた)。
 * failures は続けて見つからなかった回数
 */
export const batches = sqliteTable(
  "batches",
  {
    id: id(),
    kind: text("kind", { enum: ["distill", "findings", "ideas", "urgent"] }).notNull(),
    week: text("week").notNull(),
    batchId: text("batch_id"),
    status: text("status", { enum: ["pending", "submitted", "applied", "unknown", "failed"] }).notNull(),
    detail: json("detail"),
    createdAt: time("created_at").notNull(),
    endedAt: time("ended_at"),
    failures: integer("failures").notNull().default(0),
  },
  (t) => [uniqueIndex("batches_kind_week").on(t.kind, t.week)],
);

/** オーナーの情報。項目ごとに暗号にし、拡張と項目で 1 行だけにする */
export const ownerData = sqliteTable(
  "owner_data",
  {
    id: id(),
    extId: text("ext_id").notNull(),
    field: text("field").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [uniqueIndex("owner_data_field").on(t.extId, t.field)],
);

/** オーナーの情報を読んだ記録。追記専用 */
export const ownerDataReads = sqliteTable("owner_data_reads", {
  id: id(),
  at: time("at").notNull(),
  by: text("by").notNull(),
  extId: text("ext_id").notNull(),
  field: text("field").notNull(),
  nodeId: text("node_id"),
});

/**
 * 設計書から作った Issue。1 行が親か子の Issue 1 件。GitHub に送る前に pending の行を取り、作れたら open にする (開発の回し方の 3.3)
 * 一意は、親が (サービス、機能)、子が (サービス、機能、要件、本文のハッシュ)。mark_key は本文の隠した印の鍵で、送り直しで同じ Issue を探す
 */
export const devIssues = sqliteTable(
  "dev_issues",
  {
    id: id(),
    serviceId: text("service_id").notNull(),
    repo: text("repo").notNull(),
    number: integer("number"),
    issueId: integer("issue_id"),
    parentNumber: integer("parent_number"),
    kind: text("kind", { enum: ["parent", "child"] }).notNull(),
    feature: text("feature").notNull(),
    requirement: text("requirement"),
    reqHash: text("req_hash"),
    issueKind: text("issue_kind", { enum: ["bug", "feature", "chore"] }),
    paths: json("paths"),
    markKey: text("mark_key").notNull(),
    state: text("state", { enum: ["pending", "open", "closed"] }).notNull(),
    createdAt: time("created_at").notNull(),
    closedAt: time("closed_at"),
  },
  (t) => [
    uniqueIndex("dev_issues_parent").on(t.serviceId, t.feature).where(sql`${t.kind} = 'parent'`),
    uniqueIndex("dev_issues_child").on(t.serviceId, t.feature, t.requirement, t.reqHash).where(sql`${t.kind} = 'child'`),
    uniqueIndex("dev_issues_number").on(t.repo, t.number),
    uniqueIndex("dev_issues_mark").on(t.markKey),
  ],
);
