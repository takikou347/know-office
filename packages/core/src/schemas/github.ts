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
