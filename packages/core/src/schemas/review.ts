// know-office の中のレビューの入力と返す形、GitHub に写す順番待ちの中身 (タスクとレビューの 3.6、ルートの一覧の 1.9)
import { z } from "./zod.ts";

const Uuid = z.uuid().openapi({ description: "UUID v7" });
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

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
  .object({ verdict: OwnerVerdict, body: z.string().max(20_000), baseSha: Sha })
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
  .object({ path: RepoPath, line: z.number().int().min(1).max(1_000_000), side: NoteSide, body: z.string().min(1).max(20_000) })
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
  .object({ path: RepoPath, content: z.string().max(500_000), baseSha: Sha, message: z.string().min(1).max(1000) })
  .strict()
  .meta({ id: "CreateCommitInput" });

/** コミットする入力の型 */
export type CreateCommitInput = z.infer<typeof CreateCommitInput>;

/** 足したコミット */
export const Commit = z.object({ sha: z.string() }).strict().meta({ id: "Commit" });

/** 足したコミットの型 */
export type Commit = z.infer<typeof Commit>;

/** GitHub に写すレビューの中身。event は GitHub のレビューの種類 */
export const MirrorReviewPayload = z.object({ event: z.enum(["APPROVE", "REQUEST_CHANGES"]), body: z.string().max(65_536), commitId: Sha }).strict();

/** GitHub に写すレビューの中身の型 */
export type MirrorReviewPayload = z.infer<typeof MirrorReviewPayload>;

/** GitHub に写す行のコメントの中身。side は GitHub の LEFT (前) と RIGHT (後) */
export const MirrorCommentPayload = z
  .object({ noteId: Uuid, path: RepoPath, line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]), body: z.string().min(1).max(65_536), commitId: Sha })
  .strict();

/** GitHub に写す行のコメントの中身の型 */
export type MirrorCommentPayload = z.infer<typeof MirrorCommentPayload>;
