// GitHub のルールの返す形と入力、ゲートウェイが読む GitHub の REST API の返事の形 (タスクとレビューの 3.2 から 3.4)
import { RepoPath } from "./review.ts";
import { z } from "./zod.ts";

/**
 * リポジトリの名前 `<持ち主>/<名前>`。URL の道に入れるので、持ち主は英数字とハイフン、名前は `.` と `..` を断る
 * GitHub の持ち主の名前は 39 字まで、リポジトリの名前は 100 字まで
 */
export const RepoName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[\w.-]{1,100}$/);

/** 触れるリポジトリの並び。null は連携したものすべて */
const Repos = z
  .array(RepoName)
  .max(100)
  .refine((v) => new Set(v).size === v.length, { message: "同じリポジトリが 2 度ある" })
  .nullable()
  .openapi({ description: "触れるリポジトリ。null は連携したものすべて" });

/** 設定 `github.rules` の値。触れるリポジトリ */
export const GitHubRulesValue = z.object({ repos: Repos }).strict();

/** ルールセットを掛け直した結果。掛けたのは公開のリポジトリだけ */
export const GitHubRulesApplied = z
  .object({ applied: z.array(RepoName).openapi({ description: "ルールセットを掛けたリポジトリ。非公開のリポジトリはゲートウェイの判断で守るので入らない" }) })
  .strict()
  .meta({ id: "GitHubRulesApplied" });

/** ルールセットを掛け直した結果の型 */
export type GitHubRulesApplied = z.infer<typeof GitHubRulesApplied>;

/** GitHub と連携した今。none は未連携、app_created は App を作ってインストールする前、installed は連携済み */
export const GitHubLink = z
  .object({ state: z.enum(["none", "app_created", "installed"]).openapi({ description: "none は未連携、app_created は App を作ってインストールする前、installed は連携済み" }) })
  .strict()
  .meta({ id: "GitHubLink" });

/** GitHub と連携した今の型 */
export type GitHubLink = z.infer<typeof GitHubLink>;

/** GitHub のルール。version は変える時に送るバージョン */
export const GitHubRules = z
  .object({
    repos: Repos,
    version: z.number().int().openapi({ description: "変える時に送るバージョン。一度も変えていなければ 0" }),
  })
  .strict()
  .meta({ id: "GitHubRules" });

/** GitHub のルールの型 */
export type GitHubRules = z.infer<typeof GitHubRules>;

/** GitHub のルールを変える入力 */
export const UpdateGitHubRulesInput = z
  .object({
    version: z.number().int().openapi({ description: "取得した時点のバージョン。現在と異なる場合は 409 conflict" }),
    repos: Repos,
    reason: z.string().min(1).max(2000),
  })
  .strict()
  .meta({ id: "UpdateGitHubRulesInput" });

/** GitHub のルールを変える入力の型 */
export type UpdateGitHubRulesInput = z.infer<typeof UpdateGitHubRulesInput>;

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/** GET /repos/{o}/{r} の返事のうち使う所 */
export const GitHubRepo = z.object({ private: z.boolean(), default_branch: z.string().min(1).max(255) }).loose();

/** GET /repos/{o}/{r}/rulesets の返事のうち使う所 */
export const GitHubRulesets = z.array(z.object({ id: z.number().int().positive(), name: z.string() }).loose()).max(100);

/** ルールセットを作った、置き換えた返事のうち使う所 */
export const GitHubRuleset = z.object({ id: z.number().int().positive() }).loose();

/** GET /repos/{o}/{r}/commits/{ref}/check-runs の返事のうち使う所 */
export const GitHubCheckRuns = z
  .object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(z.object({ name: z.string().min(1).max(255), status: z.string(), conclusion: z.string().nullable() }).loose()).max(100),
  })
  .loose();

/** compare とプルリクエストのファイルの一覧が返す、変わった 1 ファイルのうち使う所 */
const GitHubChangedFile = z.object({ filename: z.string().min(1), previous_filename: z.string().min(1).optional(), status: z.string().optional(), patch: z.string().optional() }).loose();

/** GET /repos/{o}/{r}/compare/{base}...{head} の返事のうち使う所。ファイルは比べる全体で 300 件までで、それより多ければ切れる。status は head が base に対して ahead、behind、identical、diverged のどれか */
export const GitHubCompare = z.object({ status: z.enum(["ahead", "behind", "identical", "diverged"]).optional(), files: z.array(GitHubChangedFile).default([]) }).loose();

/** GET /repos/{o}/{r}/pulls/{n}/files の 1 ページ。1 ページ 100 件まで、全体で 3,000 件まで */
export const GitHubPullFiles = z.array(GitHubChangedFile).max(100);

/** GET /repos/{o}/{r}/contents/{path} の返事のうち使う所。1MB を超えるファイルは encoding が none で中身が空 */
export const GitHubContent = z.object({ type: z.string(), encoding: z.string(), content: z.string() }).loose();

/** プルリクエストの返事のうち使う所 */
export const GitHubPull = z.object({ number: z.number().int().positive(), base: z.object({ sha: Sha }).loose(), head: z.object({ ref: z.string().optional(), sha: Sha }).loose() }).loose();

/** GET /repos/{o}/{r}/pulls/{n} の返事のうち使う所。state は open か closed で、入った物は closed のまま merged が true になる (GitHub の REST API の Pulls) */
export const GitHubPullState = z.object({ state: z.enum(["open", "closed"]), merged: z.boolean(), head: z.object({ sha: Sha }).loose() }).loose();

/** GET /repos/{o}/{r}/git/ref/{ref} の返事のうち使う所 */
export const GitHubRef = z.object({ object: z.object({ sha: Sha }).loose() }).loose();

/** GitHub の数の ID (App、インストール)。JavaScript の数で正しく持てる範囲だけを受ける */
export const GitHubId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** App の URL に入る名前。小文字の英数字とハイフン */
export const AppSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/);

/** POST /api/v1/github/connect の返す形。画面は action へ manifest を form で送る */
export const GitHubManifest = z
  .object({
    action: z.url(),
    manifest: z.record(z.string(), z.unknown()).nullable(),
    state: z.string().nullable(),
  })
  .strict()
  .meta({ id: "GitHubManifest" });

/** GitHub App の manifest の返す形の型 */
export type GitHubManifest = z.infer<typeof GitHubManifest>;

/** 連携したリポジトリ */
export const Repo = z.object({ fullName: z.string(), private: z.boolean() }).strict().meta({ id: "Repo" });

/** 連携したリポジトリの型 */
export type Repo = z.infer<typeof Repo>;

/** GET /api/v1/github/callback のクエリ。code は GitHub の道に入れるので、英数字とハイフンと下線だけを受ける */
export const GitHubCallbackQuery = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    state: z.string().regex(/^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{43}$/),
  })
  .strict();

/** GET /api/v1/github/installed のクエリ。名前は GitHub の決まりのまま */
export const GitHubInstalledQuery = z
  .object({
    installation_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    setup_action: z.enum(["install", "update"]).optional(),
  })
  .strict();

/** POST /app-manifests/{code}/conversions の返事のうち使う所 */
export const GitHubAppConversion = z
  .object({
    id: GitHubId,
    slug: AppSlug,
    pem: z.string().min(100).max(10_000),
    webhook_secret: z.string().min(16).max(200),
  })
  .loose();

/** GET /app/installations/{id} の返事のうち使う所 */
export const GitHubInstallation = z.object({ id: GitHubId, app_id: GitHubId }).loose();

/** POST /app/installations/{id}/access_tokens の返事のうち使う所 */
export const GitHubAccessToken = z
  .object({
    token: z.string().regex(/^ghs_[A-Za-z0-9_]{1,255}$/),
    expires_at: z.iso.datetime(),
    permissions: z.record(z.string(), z.enum(["read", "write"])),
    repositories: z.array(z.object({ full_name: RepoName }).loose()).optional(),
  })
  .loose();

/** GET /installation/repositories の返事のうち使う所 */
export const GitHubInstallationRepos = z
  .object({
    total_count: z.number().int().nonnegative(),
    repositories: z.array(z.object({ full_name: RepoName, private: z.boolean() }).loose()).max(100),
  })
  .loose();

/** vault の github_app に置く値。App の元の鍵 */
export const GitHubAppKeys = z
  .object({
    appId: GitHubId,
    slug: AppSlug,
    privateKey: z.string().min(100).max(10_000),
    webhookSecret: z.string().min(16).max(200),
  })
  .strict();

/** vault の github_installation に置く値 */
export const GitHubInstallationKey = z.object({ id: GitHubId }).strict();

/** X-GitHub-Delivery。GitHub は版を約束しないので、UUID の形だけを確かめる */
export const DeliveryId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** X-Hub-Signature-256 */
export const HubSignature = z.string().regex(/^sha256=[0-9a-f]{64}$/);

/** X-GitHub-Event */
export const GitHubEventName = z.string().regex(/^[a-z_]{1,64}$/);

/** 通知の本文のうち、どの通知にもある所 */
export const GitHubWebhookHead = z
  .object({
    action: z.string().max(64).optional(),
    installation: z.object({ id: GitHubId }).loose().optional(),
    repository: z.object({ full_name: RepoName }).loose().optional(),
  })
  .loose();

/** 通知の本文のリポジトリ。既定のブランチも持つ */
const HookRepository = z.object({ full_name: RepoName, default_branch: z.string().min(1).max(255) }).loose();

/** 道の並び。GitHub は push の 1 コミットに 3,000 ファイルまでを並べる */
const HookPaths = z.array(z.string().max(4096)).max(3000);

/** push の通知のうち使う所。commits は 2,048 件までで、超えた分は並ばない */
export const GitHubPushEvent = z
  .object({
    ref: z.string().max(255),
    after: Sha,
    repository: HookRepository,
    commits: z
      .array(z.object({ added: HookPaths.optional(), modified: HookPaths.optional(), removed: HookPaths.optional() }).loose())
      .max(2048)
      .optional(),
  })
  .loose();

/** deployment_status の通知のうち使う所 */
export const GitHubDeploymentStatusEvent = z
  .object({
    deployment_status: z.object({ state: z.string().max(64), environment: z.string().max(255) }).loose(),
    deployment: z.object({ id: GitHubId, sha: Sha, task: z.string().max(255), environment: z.string().max(255) }).loose(),
    repository: HookRepository,
  })
  .loose();

/** workflow_run の通知のうち使う所 */
export const GitHubWorkflowRunEvent = z
  .object({
    workflow_run: z
      .object({ id: GitHubId, path: z.string().max(255), head_branch: z.string().max(255).nullable(), head_sha: Sha, status: z.string().max(64), conclusion: z.string().max(64).nullable() })
      .loose(),
    repository: HookRepository,
  })
  .loose();

/** npm のパッケージの名前。npm の決まりで 214 字まで */
export const PackageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/);

/** リポジトリから読んだ package.json のうち使う所。dependencies は使う側の版を読むのに使う */
export const PackageManifest = z
  .object({
    name: PackageName,
    version: z.string().max(64).optional(),
    dependencies: z.record(z.string().max(214), z.string().max(255)).optional(),
  })
  .loose();

/** check_run の通知のうち使う所 */
export const CheckRunEvent = z
  .object({
    check_run: z.object({ name: z.string().min(1).max(255), status: z.string().max(64), conclusion: z.string().max(64).nullable(), head_sha: Sha }).loose(),
  })
  .loose();

/** check_suite の通知のうち使う所 */
export const CheckSuiteEvent = z.object({ check_suite: z.object({ head_sha: Sha }).loose() }).loose();

/** pull_request の通知のうち使う所 */
export const PullRequestEvent = z.object({ pull_request: z.object({ number: z.number().int().positive(), head: z.object({ sha: Sha }).loose() }).loose() }).loose();

/** issues の通知のうち使う所。プルリクエストも issues で届くので pull_request で見分ける */
export const IssuesEvent = z
  .object({
    issue: z.object({ number: z.number().int().positive(), title: z.string().min(1).max(256), body: z.string().max(65_536).nullable().optional(), pull_request: z.unknown().optional() }).loose(),
    sender: z.object({ type: z.string().max(64) }).loose().optional(),
  })
  .loose();

/** 通知とレビューの API に載る GitHub の利用者のうち使う所 */
const GitHubUser = z.object({ login: z.string().min(1).max(255), type: z.string().max(64) }).loose();

/** 書いた者とリポジトリの関わり。OWNER はリポジトリの持ち主 */
const AuthorAssociation = z.string().max(64);

/** POST /repos/{o}/{r}/pulls/{n}/reviews と /comments の返事のうち使う所 */
export const GitHubPosted = z.object({ id: GitHubId }).loose();

/** Git の API (blobs、trees、commits) の返事のうち使う所 */
export const GitHubGitObject = z.object({ sha: Sha }).loose();

/** GET /repos/{o}/{r}/git/trees/{sha} の返事のうち使う所。1 階だけを読む */
export const GitHubGitTree = z
  .object({
    tree: z.array(z.object({ path: z.string().min(1).max(4096), mode: z.string().regex(/^[0-7]{5,6}$/), type: z.string().max(16), sha: Sha }).loose()).max(100_000),
    truncated: z.boolean(),
  })
  .loose();

/** GET /repos/{o}/{r}/pulls/{n}/reviews と /comments の 1 ページのうち使う所。本文の目印で写した物を探す */
export const GitHubPostedList = z.array(z.object({ id: GitHubId, body: z.string().max(70_000).nullable() }).loose()).max(100);

/** GET /repos/{o}/{r}/issues の返事の 1 ページ。プルリクエストも混じり、pull_request の項目で分かる。1 ページ 100 件まで */
export const GitHubIssueList = z
  .array(z.object({ number: z.number().int().positive(), id: GitHubId, state: z.enum(["open", "closed"]), body: z.string().max(70_000).nullable().optional(), pull_request: z.unknown().optional() }).loose())
  .max(100);

/** POST /repos/{o}/{r}/issues の返事のうち使う所。番号と、sub-issue のつなぎに使う ID */
export const GitHubIssueCreated = z.object({ number: z.number().int().positive(), id: GitHubId }).loose();

/** GET /repos/{o}/{r}/git/commits/{sha} の返事のうち使う所 */
export const GitHubGitCommit = z.object({ sha: Sha, tree: z.object({ sha: Sha }).loose() }).loose();

/** pull_request_review の通知のうち使う所。commit_id はレビューしたコミットで、レビューの今の先と同じ時だけ写す */
export const PullRequestReviewEvent = z
  .object({
    review: z
      .object({ id: GitHubId, state: z.string().max(64), body: z.string().max(65_536).nullable().optional(), user: GitHubUser.nullable(), author_association: AuthorAssociation, commit_id: Sha })
      .loose(),
    pull_request: z.object({ number: z.number().int().positive() }).loose(),
  })
  .loose();

/** pull_request_review_comment の通知のうち使う所。line は古い差分に付いたコメントでは null */
export const PullRequestReviewCommentEvent = z
  .object({
    comment: z
      .object({
        id: GitHubId,
        body: z.string().min(1).max(65_536),
        path: RepoPath,
        line: z.number().int().positive().nullable().optional(),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
        user: GitHubUser.nullable(),
        author_association: AuthorAssociation,
      })
      .loose(),
    pull_request: z.object({ number: z.number().int().positive() }).loose(),
  })
  .loose();
