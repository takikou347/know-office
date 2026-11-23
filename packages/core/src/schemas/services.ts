// サービスの返す形と入力。アイデアから運用までの流れ (サービスと拡張の 3.1、データの 2 章)
import { RepoName } from "./github.ts";
import { StaffId } from "./workday.ts";
import { NodeStatus } from "./work.ts";
import { masterSchema } from "../master/master.ts";
import { SERVICE_KINDS } from "../master/service-kinds.ts";
import { SERVICE_STAGES } from "../master/service-stages.ts";
import { z } from "./zod.ts";

/** サービスの種類。ライブラリ、Web アプリ、コンテンツ */
export const ServiceKind = masterSchema(SERVICE_KINDS);

/** サービスの種類の型 */
export type ServiceKind = z.infer<typeof ServiceKind>;

/** サービスの段階。アイデア、検討、試作、サービス、運用と、見送った、閉じた */
export const ServiceStage = masterSchema(SERVICE_STAGES);

/** サービスの段階の型 */
export type ServiceStage = z.infer<typeof ServiceStage>;

/** オーナーが移せる先。idea へは戻せない */
export const AdvanceStage = ServiceStage.exclude(["idea"]);

/** 移れる段階。段階を飛ばさず、見送りは作るまで、閉じるのはサービスと運用だけ */
export const NEXT_STAGES: Record<ServiceStage, readonly ServiceStage[]> = {
  idea: ["study", "dropped"],
  study: ["prototype", "dropped"],
  prototype: ["service", "dropped"],
  service: ["operation", "closed"],
  operation: ["closed"],
  dropped: [],
  closed: [],
};

/** 社員が閉じる案を出せる段階 */
export const CLOSABLE_STAGES = ["service", "operation"] as const satisfies readonly ServiceStage[];

/** サービスの一覧の 1 件 */
export const ServiceCard = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    name: z.string(),
    kind: ServiceKind,
    stage: ServiceStage,
    staffId: z.string().nullable(),
    repo: z.string().nullable(),
  })
  .strict()
  .meta({ id: "ServiceCard" });

/** サービスの一覧の 1 件の型 */
export type ServiceCard = z.infer<typeof ServiceCard>;

/** サービスの出来事 */
const ServiceEvent = z
  .object({
    at: z.iso.datetime(),
    kind: z.enum(["stage", "deploy", "rollback", "release", "uses"]),
    by: z.string().openapi({ description: "`owner`、社員 ID、`system` のどれか" }),
    detail: z.record(z.string(), z.unknown()).openapi({ additionalProperties: true, description: "段階の出来事は移った先の `to` と理由の `reason` を持つ" }),
  })
  .strict();

/** 公開したバージョンの形。x.y.z と、あれば - の後の印 (Semantic Versioning 2.0.0 の 2 と 9) */
export const Semver = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,40})?$/);

/**
 * 版を数の並びと - の後の印に分ける
 * @param v 版
 * @returns 数の並びと印
 */
function splitSemver(v: string): { nums: number[]; pre: string } {
  const [core = "", pre = ""] = v.split(/-(.*)/s);
  return { nums: core.split(".").map(Number), pre };
}

/**
 * 2 つのバージョンを比べる。- の印の付いた版は同じ数の印の無い版より前とし、印どうしは文字の順で比べる
 * @param a 比べる版
 * @param b 比べる版
 * @returns a が前なら負、同じなら 0、後なら正
 */
export function compareSemver(a: string, b: string): number {
  const x = splitSemver(a);
  const y = splitSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === "") return 1;
  if (y.pre === "") return -1;
  return x.pre < y.pre ? -1 : 1;
}

const At = z.iso.datetime();

/** ライブラリの様子。パッケージと説明のサイトの版、そろっているか、npm への公開、使っているサービスの版 */
const LibraryStatus = z
  .object({
    kind: z.literal("library"),
    version: z.string().nullable().openapi({ description: "最新の公開の版。そろっていなければいちばん新しい版。まだ無ければ null" }),
    packages: z.array(z.object({ name: z.string(), version: z.string() }).strict()).openapi({ description: "最新の push で読んだパッケージと説明のサイトの版" }),
    aligned: z.boolean().openapi({ description: "パッケージと説明のサイトの版がそろっているか" }),
    releasedAt: At.nullable(),
    publish: z.object({ at: At, passed: z.boolean() }).strict().nullable().openapi({ description: "最新の npm への公開の結果" }),
    usedBy: z
      .array(z.object({ serviceId: z.uuid(), name: z.string(), version: z.string(), behind: z.boolean() }).strict())
      .openapi({ description: "このライブラリを使っているサービスと版。behind は最新の公開より古いか" }),
  })
  .strict();

/** Web アプリの様子。版、デプロイと戻し、利用者数、失敗率、費用 */
const WebAppStatus = z
  .object({
    kind: z.literal("web_app"),
    version: z.string().nullable(),
    deployedAt: At.nullable(),
    rolledBackAt: At.nullable(),
    users: z.number().int().nullable().openapi({ description: "直前 24 時間の訪問の数 (画面が知らせた訪問を Workers Analytics Engine で数えた和)。訪問を数えていなければ null" }),
    errorRate: z.number().nullable().openapi({ description: "直前 24 時間の失敗の割合 (0 から 1)。返事が無ければ null" }),
    costMicroUsd: z.number().int().openapi({ description: "今月の費用" }),
  })
  .strict();

/** コンテンツの様子。公開した物と読まれた数 */
const ContentStatus = z
  .object({
    kind: z.literal("content"),
    published: z.array(z.object({ at: At, title: z.string() }).strict()),
    reads: z.number().int().nullable().openapi({ description: "直前 24 時間の読まれた数。まだ無ければ null" }),
  })
  .strict();

/** 種類ごとのサービスの様子 */
export const ServiceStatus = z.discriminatedUnion("kind", [LibraryStatus, WebAppStatus, ContentStatus]).meta({ id: "ServiceStatus" });

/** 種類ごとのサービスの様子の型 */
export type ServiceStatus = z.infer<typeof ServiceStatus>;

/** サービスの詳細。案の中身、検討の材料、見送った理由、出来事を持つ */
export const ServiceDetail = z
  .intersection(
    ServiceCard,
    z
      .object({
        aim: z.string(),
        users: z.string(),
        costEstimateMicroUsd: z.number().int().openapi({ description: "月の費用の見込み" }),
        revenueEstimateMicroUsd: z.number().int().openapi({ description: "月の売り上げの見込み" }),
        study: z.string().nullable().openapi({ description: "社長が調べた検討の材料。まだ無ければ null" }),
        droppedReason: z.string().nullable().openapi({ description: "見送った理由。見送っていなければ null" }),
        status: ServiceStatus,
        events: z.array(ServiceEvent),
      })
      .strict(),
  )
  .meta({ id: "ServiceDetail" });

/** サービスの詳細の型 */
export type ServiceDetail = z.infer<typeof ServiceDetail>;

// お金は月の見込みのマイクロドル。JSON で崩れない整数の範囲にする
const MicroUsd = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** 案を足す入力。オーナーの API と社員の idea_add が同じ形を使う。要るのは名前と一言 (狙い) だけで、ほかは後から直す */
export const CreateIdeaInput = z
  .object({
    title: z.string().min(1).max(100),
    kind: ServiceKind.default("web_app").openapi({ description: "無ければ `web_app`。作ると決める前なら後から直せる" }),
    aim: z.string().min(1).max(2000).openapi({ description: "狙いの一言" }),
    users: z.string().max(500).default("").openapi({ description: "使う人。無ければ空" }),
    costEstimateMicroUsd: MicroUsd.default(0).openapi({ description: "月の費用の見込み。無ければ 0" }),
    revenueEstimateMicroUsd: MicroUsd.default(0).openapi({ description: "月の売り上げの見込み。無ければ 0" }),
  })
  .strict()
  .meta({ id: "CreateIdeaInput" });

/** 案を足す入力の型 */
export type CreateIdeaInput = z.infer<typeof CreateIdeaInput>;

/** アイデア出しのバッチ処理で社長のモデルが返す 1 件の案。足す時の上限は案を足す入力と同じで、種類と使う人も要る */
export const IdeaProposal = z
  .object({ title: CreateIdeaInput.shape.title, kind: ServiceKind, aim: CreateIdeaInput.shape.aim, users: z.string().min(1).max(500) })
  .strict();

/** 元の案を直す入力。送った項目だけを書く。種類は作ると決める前だけ直せる */
export const UpdateServiceInput = z
  .object({
    title: CreateIdeaInput.shape.title.optional(),
    kind: ServiceKind.optional().openapi({ description: "`idea` と `study` の段階の時だけ直せる" }),
    aim: CreateIdeaInput.shape.aim.optional(),
    users: z.string().max(500).optional(),
    costEstimateMicroUsd: MicroUsd.optional().openapi({ description: "月の費用の見込み" }),
    revenueEstimateMicroUsd: MicroUsd.optional().openapi({ description: "月の売り上げの見込み" }),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "直す項目を 1 つ以上送る" })
  .meta({ id: "UpdateServiceInput" });

/** 元の案を直す入力の型 */
export type UpdateServiceInput = z.infer<typeof UpdateServiceInput>;

/** アイデア出しの答え。案は 1 件ずつ確かめ、形の違う物だけを捨てる */
export const IdeasAnswer = z.object({ ideas: z.array(z.unknown()).max(20) }).loose();

/** 段階を移す入力。staffId は prototype に進める時に要る */
export const AdvanceInput = z
  .object({
    to: AdvanceStage,
    reason: z.string().min(1).max(2000),
    staffId: StaffId.optional().openapi({ description: "`prototype` に進める時に決める担当の社員" }),
    repo: RepoName.optional().openapi({ description: "`prototype` に進める時に、GitHub の触れるリポジトリから決めるリポジトリ" }),
  })
  .strict()
  .meta({ id: "AdvanceInput" });

/** 段階を移す入力の型 */
export type AdvanceInput = z.infer<typeof AdvanceInput>;

/** 前のバージョンに戻す入力 */
export const RollbackInput = z.object({ reason: z.string().min(1).max(2000) }).strict().meta({ id: "RollbackInput" });

/** 前のバージョンに戻す入力の型 */
export type RollbackInput = z.infer<typeof RollbackInput>;

/** 戻しやデプロイの受け付け。id は、戻しは service_events の rollback の行の ID、本番へのデプロイは受け付けの ID (デプロイの錠と監査ログの deploymentId) */
export const Deployment = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7。戻しは `service_events` の `rollback` の行の ID、本番へのデプロイは受け付けの ID (監査ログ `service.deploy` の `deploymentId`)" }),
    status: z.enum(["queued", "running", "done", "failed"]),
  })
  .strict()
  .meta({ id: "Deployment" });

/** 戻しやデプロイの受け付けの型 */
export type Deployment = z.infer<typeof Deployment>;

/** service_events の kind。段階、デプロイ、戻し、公開、ほかのサービスのライブラリを使う版 */
export const SERVICE_EVENT_KINDS = ["stage", "deploy", "rollback", "release", "uses"] as const;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** service_events の release の detail。key は読んだ版の組で、同じ組の公開を 1 行にする */
export const ReleaseDetail = z
  .object({
    key: z.string().max(4000),
    version: Semver,
    packages: z.array(z.object({ name: z.string().max(214), version: Semver }).strict()).max(10),
    aligned: z.boolean(),
    commit: Sha40,
  })
  .strict();

/** service_events の uses の detail。ほかのサービスのライブラリのどの版を使っているか */
export const UsesDetail = z.object({ library: z.uuid(), version: Semver, commit: Sha40 }).strict();

/** service_events の deploy の detail。Web アプリとコンテンツは GitHub のデプロイ、ライブラリは npm への公開の workflow */
export const DeployDetail = z.union([
  z.object({ deploymentId: z.number().int().positive(), version: z.string().max(64), commit: Sha40 }).strict(),
  z.object({ runId: z.number().int().positive(), passed: z.boolean(), version: Semver.nullable(), commit: Sha40 }).strict(),
]);

/** service_events の rollback の detail */
export const RollbackDetail = z.object({ reason: z.string().max(2000), ref: z.string().max(255), stopId: z.uuid().nullable() }).strict();

/** Issue の状態 */
export const DevIssueState = z.enum(["open", "closed"]);

/** 子 Issue 1 件。task は同じ番号の開発担当のタスクで、まだ無ければ null */
export const ServiceIssueChild = z
  .object({
    number: z.number().int().positive(),
    requirement: z.string().nullable(),
    kind: z.enum(["bug", "feature", "chore"]).nullable(),
    state: DevIssueState,
    task: z.object({ id: z.uuid(), status: NodeStatus, prNumber: z.number().int().positive().nullable() }).strict().nullable(),
  })
  .strict();

/** 親 Issue 1 件と、その子 */
export const ServiceIssueParent = z
  .object({
    number: z.number().int().positive(),
    feature: z.string(),
    state: DevIssueState,
    /** 運用の親か (機能の親でなく、見つけて直す仕組みが作った Issue をまとめる親) */
    operations: z.boolean(),
    children: z.array(ServiceIssueChild),
  })
  .strict();

/** 設計書の PR 1 件。design は設計書を書くタスクの PR、together は同じ時に直す設計書の PR */
export const ServiceDocsPr = z
  .object({
    repo: z.string(),
    number: z.number().int().positive(),
    kind: z.enum(["design", "together"]),
    task: z.object({ id: z.uuid(), status: NodeStatus }).strict(),
  })
  .strict();

/** GET /api/v1/services/{serviceId}/issues の返事。ready は機能の親がすべて閉じていて、入れて閉じた親が 1 つ以上ある事 */
export const ServiceIssues = z
  .object({
    ready: z.boolean(),
    docsPrs: z.array(ServiceDocsPr),
    parents: z.array(ServiceIssueParent),
  })
  .strict();

/** GET /api/v1/services/{serviceId}/issues の返事の型 */
export type ServiceIssues = z.infer<typeof ServiceIssues>;
