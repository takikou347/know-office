// GitHub のルールの返す形と入力、ゲートウェイが読む GitHub の REST API の返事の形 (タスクとレビューの 3.2 から 3.4)
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

/** GET /repos/{o}/{r}/compare/{base}...{head} の返事のうち使う所 */
export const GitHubCompare = z
  .object({
    files: z.array(z.object({ filename: z.string().min(1), previous_filename: z.string().min(1).optional() }).loose()).default([]),
  })
  .loose();

/** プルリクエストの返事のうち使う所 */
export const GitHubPull = z.object({ number: z.number().int().positive(), base: z.object({ sha: Sha }).loose(), head: z.object({ sha: Sha }).loose() }).loose();

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
