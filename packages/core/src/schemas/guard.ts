// 自動停止の形。シグナルの出来事、基準、止めた記録の返す形と入力 (自動停止の 2 章と 2 章、データの 2 章)
import { OPERATION_KINDS } from "../rules/operation.ts";
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** 止める範囲。狭い順 */
export const GuardScope = z.enum(["task", "staff", "service", "office"]);

/** 止める範囲の型 */
export type GuardScope = z.infer<typeof GuardScope>;

/** 当たったシグナルの名前。stops.signal に入る */
export const GuardSignal = z.enum([
  "rule_denied",
  "repeated_failure",
  "unchecked_merge",
  "task_overrun",
  "task_cost",
  "staff_rule_denied",
  "token_rate",
  "tool_rate",
  "exfiltration",
  "deploy_failure",
  "library_build",
  "certain_fraud",
  "stacked_suspicion",
  "manual",
]);

/** 当たったシグナルの名前の型 */
export type GuardSignal = z.infer<typeof GuardSignal>;

const Task = { staffId: StaffId, nodeId: z.uuid() };

/** ゲートウェイの中で起きた、セキュリティに関わる出来事。guard.observe に渡す (自動停止の 2 章) */
export const GuardEvent = z.union([
  z.object({ type: z.literal("rule_denied"), ...Task, operation: z.enum(OPERATION_KINDS), target: z.string() }).strict(),
  z.object({ type: z.literal("command_result"), ...Task, command: z.string(), exitCode: z.number().int(), failedCheck: z.string().nullable() }).strict(),
  z.object({ type: z.literal("merge_requested"), ...Task, checksPassed: z.boolean() }).strict(),
  z.object({ type: z.literal("usage"), staffId: StaffId, tokens: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("tool_call"), staffId: StaffId }).strict(),
  z.object({ type: z.literal("external_read"), ...Task, source: z.string() }).strict(),
  z.object({ type: z.literal("sensitive_access"), ...Task, item: z.string() }).strict(),
  z.object({ type: z.literal("chain_broken"), year: z.number().int() }).strict(),
  z.object({ type: z.literal("ticket_misuse"), staffId: StaffId, jti: z.string(), workspaceId: z.string() }).strict(),
  z.object({ type: z.literal("threshold_mismatch") }).strict(),
  z.object({ type: z.literal("login"), country: z.string(), newCountry: z.boolean() }).strict(),
  z.object({ type: z.literal("owner_info_read"), item: z.string() }).strict(),
  z
    .object({
      type: z.literal("deploy_result"),
      serviceId: z.string(),
      kind: z.literal("web"),
      deployedAt: z.number().int(),
      /** デプロイ前 24 時間の失敗率 (0 から 1) */
      baselineRate: z.number().min(0).max(1),
      responses: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("deploy_result"), serviceId: z.string(), kind: z.literal("library"), version: z.string(), buildPassed: z.boolean() }).strict(),
]);

/** 出来事の型 */
export type GuardEvent = z.infer<typeof GuardEvent>;

/** 基準。設定 `guard.thresholds` の値。時間はミリ秒、率は 1 万分率 (自動停止の 3.1) */
export const Thresholds = z
  .object({
    /** 同じタスク、同じ操作、同じ相手のルールの外をまとめる間 */
    ruleMergeMs: z.number().int().positive(),
    /** タスクを止める、同じ失敗の続いた数 */
    repeatedFailures: z.number().int().positive(),
    /** 1 つのタスクの最長。止められていた間と待っていた間を入れない */
    taskMaxMs: z.number().int().positive(),
    /** 社員を止める、直前の間のルールの外の数 */
    staffRuleDenied: z.number().int().positive(),
    /** 社員のルールの外を数える間 */
    staffWindowMs: z.number().int().positive(),
    /** 速さを数える 1 区切り */
    bucketMs: z.number().int().positive(),
    /** 普段の値の何倍を超えたら速すぎるか */
    rateMultiplier: z.number().positive(),
    /** 速すぎる区切りが続いたら止める数 */
    rateBuckets: z.number().int().positive(),
    /** 普段の値を作る日数。足りない間は通知だけ */
    baselineDays: z.number().int().positive(),
    /** デプロイの後に失敗率を見る間 */
    deployWindowMs: z.number().int().positive(),
    /** デプロイの後の失敗率の下限 (1 万分率) */
    deployFailureBp: z.number().int().positive(),
    /** デプロイ前の失敗率の何倍を超えたら戻すか */
    deployMultiplier: z.number().positive(),
    /** 失敗率で判断する返事の数の下限 */
    deployMinResponses: z.number().int().positive(),
    /** 新しい国のログインの後に重なりを見る間 */
    loginWindowMs: z.number().int().positive(),
    /** オーナーの情報の読み出しを数える間 */
    ownerReadWindowMs: z.number().int().positive(),
    /** その間にこれを超えたら重なった怪しい動き */
    ownerReads: z.number().int().positive(),
    /** 基準のこの割合 (1 万分率) に届いたら近かったとする */
    nearBp: z.number().int().positive(),
    /** 同じシグナルと相手の近かったをまとめる間 */
    nearMergeMs: z.number().int().positive(),
  })
  .strict();

/** 基準の型 */
export type Thresholds = z.infer<typeof Thresholds>;

const MINUTE = 60_000;

/** 基準の初期値。最初の settings の行として入れる (自動停止の 3.1) */
export const DEFAULT_THRESHOLDS: Thresholds = {
  ruleMergeMs: 10 * MINUTE,
  repeatedFailures: 3,
  taskMaxMs: 4 * 60 * MINUTE,
  staffRuleDenied: 2,
  staffWindowMs: 60 * MINUTE,
  bucketMs: 5 * MINUTE,
  rateMultiplier: 5,
  rateBuckets: 2,
  baselineDays: 7,
  deployWindowMs: 10 * MINUTE,
  deployFailureBp: 500,
  deployMultiplier: 2,
  deployMinResponses: 20,
  loginWindowMs: 30 * MINUTE,
  ownerReadWindowMs: 10 * MINUTE,
  ownerReads: 20,
  nearBp: 8000,
  nearMergeMs: 60 * MINUTE,
};

/** 出来事を数えた答え。stop は止める、near は止めずに近かったを残す (自動停止の 2 章) */
export type Judgment = {
  /** 何をするか */
  action: "none" | "near" | "stop";
  /** 範囲 */
  scope: GuardScope;
  /** 範囲の中の相手。タスク ID、社員 ID、サービス ID、office */
  target: string;
  /** 当たったシグナル */
  signal: GuardSignal | "";
  /** 数えた値 */
  measured: number;
  /** その時の基準 */
  threshold: number;
};

/** 止めた判定。正しく止めた、誤って止めた、分からない */
export const StopVerdict = z.enum(["correct", "false", "unknown"]);

const Uuid = z.uuid().openapi({ description: "UUID v7" });

/** 停止中の対象 */
export const GuardState = z
  .object({
    stopped: z.array(z.object({ scope: GuardScope, target: z.string(), stopId: Uuid, since: z.iso.datetime() }).strict()),
  })
  .strict()
  .meta({ id: "GuardState" });

/** 停止中の対象の型 */
export type GuardState = z.infer<typeof GuardState>;

/** 全体を止めた後に入れ直す外の鍵。GitHub App の鍵と Claude の API の鍵 */
export const KeyKind = z.enum(["github_app", "claude"]);

/** 入れ直す外の鍵の型 */
export type KeyKind = z.infer<typeof KeyKind>;

/** 全体を止めた後に入れ直す鍵の今 */
export const GuardKeys = z
  .object({
    held: z.boolean().openapi({ description: "全体を止めた後で、外の鍵を入れ直すまで全体を再開できない時は true" }),
    pending: z.array(KeyKind).openapi({ description: "まだ入れ直していない鍵" }),
  })
  .strict()
  .meta({ id: "GuardKeys" });

/** 入れ直す鍵の今の型 */
export type GuardKeys = z.infer<typeof GuardKeys>;

/** GitHub App の秘密鍵の PEM。GitHub は PKCS#1 で渡す */
const PrivateKeyPem = z
  .string()
  .max(10_000)
  .regex(/^-----BEGIN (RSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END (RSA )?PRIVATE KEY-----\s*$/);

/** GitHub App の鍵を入れ直す入力。止める前の連携の App で作り直した秘密鍵と通知の秘密 */
export const ReplaceGitHubAppKeyInput = z
  .object({
    privateKey: PrivateKeyPem.openapi({ description: "GitHub App の画面で作り直した秘密鍵 (PEM)" }),
    webhookSecret: z.string().min(16).max(200).openapi({ description: "GitHub App の画面で作り直した通知の秘密" }),
  })
  .strict()
  .meta({ id: "ReplaceGitHubAppKeyInput" });

/** GitHub App の鍵を入れ直す入力の型 */
export type ReplaceGitHubAppKeyInput = z.infer<typeof ReplaceGitHubAppKeyInput>;

/** Claude の API の鍵を入れ直す入力 */
export const ReplaceClaudeKeyInput = z
  .object({ apiKey: z.string().regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/).openapi({ description: "Anthropic の画面で作り直した API の鍵" }) })
  .strict()
  .meta({ id: "ReplaceClaudeKeyInput" });

/** Claude の API の鍵を入れ直す入力の型 */
export type ReplaceClaudeKeyInput = z.infer<typeof ReplaceClaudeKeyInput>;

/** 止めた記録と近かった記録の 1 行 */
export const StopRow = z
  .object({
    id: Uuid,
    at: z.iso.datetime(),
    kind: z.enum(["stop", "near"]),
    scope: GuardScope,
    target: z.string(),
    signal: z.string(),
    measured: z.number(),
    threshold: z.number(),
    by: z.enum(["system", "owner"]),
    resumedAt: z.iso.datetime().nullable(),
    verdict: StopVerdict.nullable(),
  })
  .strict()
  .meta({ id: "StopRow" });

/** 止めた記録の 1 行の型 */
export type StopRow = z.infer<typeof StopRow>;

/** 中身を決めない 1 件。直前の出来事と経緯の行 */
const Entry = z.record(z.string(), z.unknown()).openapi({ additionalProperties: true });

/** 止めた記録 1 件。直前の 20 件の操作と経緯を持つ */
export const StopDetail = z
  .intersection(
    StopRow,
    z
      .object({
        recentOps: z.array(Entry),
        updates: z.array(Entry),
        rulesVersion: z.number().int(),
        model: z.string().nullable().meta({ description: "使っていたモデル。社員にひもづかない範囲 (サービス、全体) は null" }),
        externalSources: z.array(z.string()),
      })
      .strict(),
  )
  .meta({ id: "StopDetail" });

/** 止めた記録 1 件の型 */
export type StopDetail = z.infer<typeof StopDetail>;

/** 手で止める相手 */
export const StopTargetInput = z.object({ scope: GuardScope, target: z.string() }).strict().meta({ id: "StopTargetInput" });

/** 手で止める相手の型 */
export type StopTargetInput = z.infer<typeof StopTargetInput>;

/** 手で止める入力 */
export const CreateStopInput = z.object({ scope: GuardScope, target: z.string(), reason: z.string() }).strict().meta({ id: "CreateStopInput" });

/** 手で止める入力の型 */
export type CreateStopInput = z.infer<typeof CreateStopInput>;

/** 手で止めた結果 */
export const Stop = z.object({ stopId: Uuid }).strict().meta({ id: "Stop" });

/** 止める前に見せる、止まる社員とタスクの数 */
export const StopPreview = z
  .object({ staff: z.array(StaffId.openapi({ description: "社員 ID。役割ごとに固定" })), nodes: z.number().int() })
  .strict()
  .meta({ id: "StopPreview" });

/** 止める前に見せる物の型 */
export type StopPreview = z.infer<typeof StopPreview>;

/** 判定の入力 */
export const VerdictInput = z.object({ verdict: StopVerdict, reason: z.string() }).strict().meta({ id: "VerdictInput" });

/** 再開、判定、対策の 1 行 */
export const StopUpdate = z
  .object({ id: Uuid, stopId: Uuid, at: z.iso.datetime(), kind: z.enum(["resumed", "verdict", "measure"]), by: z.enum(["system", "reviewer", "owner"]) })
  .strict()
  .meta({ id: "StopUpdate" });

/** 再開した時刻 */
export const Resumption = z.object({ resumedAt: z.iso.datetime() }).strict().meta({ id: "Resumption" });

/** 蒸留の案の種類。役目の説明文に足す決まり、基準の直し、ルールやツールの直し */
export const LessonKind = z.enum(["prompt_rule", "threshold", "rule_tool"]);

/** 蒸留の案の状態。説明文の案は承認で applied、基準の案は基準を変えた時に applied */
export const LessonStatus = z.enum(["proposed", "approved", "rejected", "applied"]);

/** 蒸留の案 */
export const Lesson = z
  .object({
    id: Uuid,
    createdAt: z.iso.datetime(),
    kind: LessonKind,
    cause: z.string(),
    proposal: z.string(),
    staffId: StaffId.nullable().openapi({ description: "説明文に決まりを足す社員。説明文の案だけが持つ" }),
    stopIds: z.array(Uuid),
    status: LessonStatus,
  })
  .strict()
  .meta({ id: "Lesson" });

/** 蒸留の案の型 */
export type Lesson = z.infer<typeof Lesson>;

/** 止めた記録をレビュー担当のモデルに聞く設定 `guard.review` の値。perDay は office 全体の 1 日の回数 */
export const GuardReview = z
  .object({
    enabled: z.boolean().meta({ description: "タスクと社員を止めた時に、止めた記録をレビュー担当のモデル (Opus) に渡し、問題が無いと返れば再開するか。開くと Claude の費用が出る" }),
    perDay: z.number().int().min(1).max(50).meta({ description: "office 全体の 1 日の聞く回数。1 回は止めた記録 1 件、出力 800 トークンまで" }),
  })
  .strict();

/** レビュー担当に聞く設定の型 */
export type GuardReview = z.infer<typeof GuardReview>;

/** レビュー担当に聞く設定の初期値。閉じて 1 日 10 回 */
export const DEFAULT_GUARD_REVIEW: GuardReview = { enabled: false, perDay: 10 };

/** 止めた記録を読んだレビュー担当が返す答え。resume が true なら再開する */
export const ReviewAnswer = z.object({ resume: z.boolean(), reason: z.string().trim().min(1).max(500) }).strict();

/** レビュー担当の答えの型 */
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

/** 蒸留でレビュー担当が返す答え。原因ごとに案を 3 件まで */
export const DistillAnswer = z
  .object({
    proposals: z
      .array(
        z.union([
          z.object({ kind: z.literal("prompt_rule"), staffId: StaffId, proposal: z.string().min(1).max(2000) }).strict(),
          z.object({ kind: z.enum(["threshold", "rule_tool"]), staffId: z.null(), proposal: z.string().min(1).max(2000) }).strict(),
        ]),
      )
      .max(3),
  })
  .strict();

/** 蒸留の答えの型 */
export type DistillAnswer = z.infer<typeof DistillAnswer>;

/** 版の付いた今の基準 */
export const GuardThresholds = z
  .object({ version: z.number().int(), values: z.record(z.string(), z.number()) })
  .strict()
  .meta({ id: "GuardThresholds" });

/** 基準を変える入力。values は変える項目だけを送り、ほかは今の値を使う */
export const UpdateThresholdsInput = z
  .object({
    version: z.number().int().openapi({ description: "取得した時点のバージョン。現在と異なる場合は 409 conflict" }),
    values: z.record(z.string(), z.number()),
    reason: z.string().max(2000),
    lessonId: Uuid.optional().openapi({ description: "入れる基準の案。承認した基準の案だけを applied にする" }),
  })
  .strict()
  .meta({ id: "UpdateThresholdsInput" });

/** 基準を変える入力の型 */
export type UpdateThresholdsInput = z.infer<typeof UpdateThresholdsInput>;

/** 自動停止の効き目。止めた回数、誤って止めた割合、多い原因、入れた対策の前後 7 日 */
export const GuardEffect = z
  .object({
    stops: z.number().int(),
    falseRatio: z.number(),
    topCauses: z.array(z.object({ signal: z.string(), count: z.number().int() }).strict()),
    measures: z.array(z.object({ lessonId: Uuid, before: z.number().int(), after: z.number().int() }).strict()),
  })
  .strict()
  .meta({ id: "GuardEffect" });

/** 自動停止の効き目の型 */
export type GuardEffect = z.infer<typeof GuardEffect>;
