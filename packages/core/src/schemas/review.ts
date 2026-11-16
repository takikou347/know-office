// know-office の中のレビューの入力と返す形、GitHub に写す順番待ちの中身 (タスクとレビューの 3.6、API の reviews)
import { z } from "./zod.ts";

const Uuid = z.uuid().openapi({ description: "UUID v7" });
/** git のコミットの SHA-1。40 字の小文字の 16 進数 */
export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * 道が制御文字を持たないか
 * @param path 道
 * @returns 持たなければ true
 */
function printable(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * リポジトリの頭からのファイルの道として使えるか。頭と末尾の `/`、空の区切り、`.` と `..` の区切り、制御文字を断る
 * @param path 道
 * @returns 使えれば true
 */
function repoPath(path: string): boolean {
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") && printable(path);
}

/** リポジトリの頭からのファイルの道。GitHub の道の上限に合わせて 4,096 字まで */
export const RepoPath = z.string().min(1).max(4096).refine(repoPath, { message: "ファイルの道の形が違う" });

/** 承認か差し戻し */
export const OwnerVerdict = z.enum(["approve", "request_changes"]);

/** 承認か差し戻しの型 */
export type OwnerVerdict = z.infer<typeof OwnerVerdict>;

/** オーナーが承認か差し戻しを出す入力。baseSha は読んだ時の head_sha で、違えば 409 */
export const ReviewVerdictInput = z
  .object({ verdict: OwnerVerdict, body: z.string().max(20_000), baseSha: CommitSha.meta({ description: "確かめた時の `head_sha`。現在と異なる場合は 409 conflict" }) })
  .strict()
  .meta({ id: "ReviewVerdictInput" });

/** 承認か差し戻しを出す入力の型 */
export type ReviewVerdictInput = z.infer<typeof ReviewVerdictInput>;

/** 承認か差し戻しを出した結果 */
export const ReviewVerdict = z.object({ nodeId: Uuid, ownerVerdict: OwnerVerdict }).strict().meta({ id: "ReviewVerdict" });

/** 承認か差し戻しを出した結果の型 */
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** 指摘の行の側。old は前、new は後 */
export const NoteSide = z.enum(["old", "new"]);

/** 行に指摘を書く入力 */
export const CreateNoteInput = z
  .object({ path: RepoPath.meta({ description: "リポジトリの頭からの道。頭と末尾の `/`、空の区切り、`.` と `..` の区切り、制御文字は 422" }), line: z.number().int().min(1).max(1_000_000), side: NoteSide, body: z.string().min(1).max(20_000) })
  .strict()
  .meta({ id: "CreateNoteInput" });

/** 行に指摘を書く入力の型 */
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

/** 行の指摘 1 件 */
export const ReviewNote = z
  .object({ id: Uuid, at: z.iso.datetime(), by: z.string(), path: z.string(), line: z.number().int(), side: NoteSide, body: z.string() })
  .strict()
  .meta({ id: "ReviewNote" });

/** 行の指摘 1 件の型 */
export type ReviewNote = z.infer<typeof ReviewNote>;

/** レビューの画面から 1 ファイルを書き換えてコミットする入力。baseSha は読んだ時の head_sha で、違えば 409 */
export const CreateCommitInput = z
  .object({ path: RepoPath.meta({ description: "リポジトリの頭からの道。頭と末尾の `/`、空の区切り、`.` と `..` の区切り、制御文字は 422" }), content: z.string().max(500_000), baseSha: CommitSha.meta({ description: "確かめた時の `head_sha`。現在と異なる場合は 409 conflict" }), message: z.string().min(1).max(1000) })
  .strict()
  .meta({ id: "CreateCommitInput" });

/** コミットする入力の型 */
export type CreateCommitInput = z.infer<typeof CreateCommitInput>;

/** 足したコミット */
export const Commit = z.object({ sha: z.string() }).strict().meta({ id: "Commit" });

/** 足したコミットの型 */
export type Commit = z.infer<typeof Commit>;

/** GitHub に写すレビューの中身。event は GitHub のレビューの種類 */
export const MirrorReviewPayload = z.object({ event: z.enum(["APPROVE", "REQUEST_CHANGES"]), body: z.string().max(65_536), commitId: CommitSha }).strict();

/** GitHub に写すレビューの中身の型 */
export type MirrorReviewPayload = z.infer<typeof MirrorReviewPayload>;

/** GitHub に写す行のコメントの中身。side は GitHub の LEFT (前) と RIGHT (後) */
export const MirrorCommentPayload = z
  .object({ noteId: Uuid, path: RepoPath, line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]), body: z.string().min(1).max(65_536), commitId: CommitSha })
  .strict();

/** GitHub に写す行のコメントの中身の型 */
export type MirrorCommentPayload = z.infer<typeof MirrorCommentPayload>;

/** 画面で分ける、変えたファイルの種類。GitHub の copied は added、changed と unchanged は modified に寄せる */
export const ReviewFileStatus = z.enum(["added", "modified", "removed", "renamed"]);

/** 変えたファイルの種類の型 */
export type ReviewFileStatus = z.infer<typeof ReviewFileStatus>;

/** レビューの概要。要点とチェックを変更の前に出し、変えたファイルは木に並べる道と種類だけを持つ。差分はファイルごとに getReviewDiff で取る */
export const ReviewHead = z
  .object({
    nodeId: Uuid,
    repo: z.string(),
    prNumber: z.number().int(),
    branch: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    lastSeenSha: z.string().nullable(),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean() }).strict()),
    reviewerSummary: z.string(),
    reviewerVerdict: z.string().nullable(),
    files: z.array(z.object({ path: z.string(), status: ReviewFileStatus, seen: z.boolean() }).strict()),
  })
  .strict()
  .meta({ id: "ReviewHead" });

/** レビューの概要の型 */
export type ReviewHead = z.infer<typeof ReviewHead>;

/** 1 ファイルの差分の問い。since は前に見た先で、あればそこからの差を返す */
export const ReviewDiffQuery = z
  .object({
    path: RepoPath.meta({ description: "リポジトリの頭からの道。頭と末尾の `/`、空の区切り、`.` と `..` の区切り、制御文字は 422" }),
    since: CommitSha.optional().meta({ description: "前に見た `last_seen_sha`。指定するとそこから今の `head_sha` までの差分を返す" }),
  })
  .strict();

/** 1 ファイルの差分。lines は行の頭に ` ` (変わらない)、`+` (足した)、`-` (消した) を付けた統一形式の行 */
export const FileDiff = z
  .object({
    path: z.string(),
    language: z.string(),
    hunks: z.array(z.object({ oldStart: z.number().int(), newStart: z.number().int(), lines: z.array(z.string()) }).strict()),
  })
  .strict()
  .meta({ id: "FileDiff" });

/** 1 ファイルの差分の型 */
export type FileDiff = z.infer<typeof FileDiff>;

/** 前か後のファイルの中身の問い。base はレビューの元、head は今の先 */
export const ReviewFileQuery = z.object({ path: RepoPath.meta({ description: "リポジトリの頭からの道。頭と末尾の `/`、空の区切り、`.` と `..` の区切り、制御文字は 422" }), ref: z.enum(["base", "head"]) }).strict();

/** 前か後のファイルの中身。ref は読んだ sha */
export const FileContent = z.object({ path: z.string(), ref: z.string(), content: z.string() }).strict().meta({ id: "FileContent" });

/** ファイルの中身の型 */
export type FileContent = z.infer<typeof FileContent>;

/** 読んだ所の印を置く入力。sha は読んだ時の head_sha で、違えば 409 */
export const SeenInput = z.object({ sha: CommitSha.meta({ description: "読んだ時の `head_sha`。現在と異なる場合は 409 conflict" }) }).strict().meta({ id: "SeenInput" });

/** 読んだ所の印を置く入力の型 */
export type SeenInput = z.infer<typeof SeenInput>;

/** 拡張子ごとの色分けの言語。画面のエディタの言語の名前と同じ */
const LANGUAGES: Readonly<Record<string, string>> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", css: "css", md: "markdown", json: "json", jsonc: "json" };

/**
 * ファイルの道の拡張子から、色分けの言語を決める
 * @param path ファイルの道
 * @returns 言語の名前。知らない物は text
 */
export function languageOfPath(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return LANGUAGES[ext] ?? "text";
}
