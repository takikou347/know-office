// office の設定とサービスの設定の返す形、入力、項目ごとの値の形と初期値 (サービスと拡張の 3.3、タスクとレビューの 3.4)
import { DEFAULT_RULES } from "../rules/decide.ts";
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** 社員が GitHub でできる操作。読む、ブランチを作る、push、プルリクエスト、main へのマージ、Issue */
export const RepoAction = z.enum(["read", "branch", "push", "pull_request", "merge", "issue"]);

/** main にマージする、本番にデプロイする条件の 1 つ。チェックの合格、レビュー担当の承認、オーナーの承認 */
export const ReleaseCondition = z.enum(["checks", "reviewer", "owner"]);

// 条件は 1 つ以上で重ならない。空の条件は誰の確かめも無しに入るので断る
const Conditions = z
  .array(ReleaseCondition)
  .min(1)
  .max(ReleaseCondition.options.length)
  .refine((v) => new Set(v).size === v.length, { message: "同じ条件が 2 度ある" });

/** 初期値を持ち、office の初期値を受け継ぐサービスの設定の項目と、値の形 */
export const INHERITED_SETTINGS = {
  actions: z
    .array(RepoAction)
    .max(RepoAction.options.length)
    .refine((v) => new Set(v).size === v.length, { message: "同じ操作が 2 度ある" }),
  mergeWhen: Conditions,
  deployWhen: Conditions,
  protectedPaths: z.array(z.string().min(1).max(200)).max(50),
  paused: z.boolean(),
} as const;

/** office の初期値を受け継ぐ項目の名前 */
export type InheritedKey = keyof typeof INHERITED_SETTINGS;

/** office の初期値を受け継ぐ項目の名前の並び。画面と一覧はこの順に出す */
export const INHERITED_KEYS = ["actions", "mergeWhen", "deployWhen", "protectedPaths", "paused"] as const satisfies readonly InheritedKey[];

/** 受け継いだ値をまとめた、ルールの判断に使うサービスの設定 */
export type ServiceRules = { [K in InheritedKey]: z.infer<(typeof INHERITED_SETTINGS)[K]> };

/** office の初期値の組み込みの値。`settings` に行が無い間に使う (タスクとレビューの 3.4 の表) */
export const DEFAULT_SERVICE_RULES: ServiceRules = {
  actions: [...RepoAction.options],
  mergeWhen: ["checks", "reviewer"],
  deployWhen: ["owner"],
  protectedPaths: [...DEFAULT_RULES.protectedPaths],
  paused: false,
};

/** 初期値を持たず、登録の時に決めるサービスの設定の項目と、値の形 */
export const OWN_SETTINGS = {
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  staffId: StaffId,
} as const;

/** 設定の 1 項目。inherited は office の初期値と同じか、version は変える時に送るバージョン */
export const Setting = z
  .object({
    key: z.string(),
    value: z.unknown().nonoptional().openapi({ description: "設定ごとの Zod スキーマに従う" }),
    inherited: z.boolean().openapi({ description: "office の初期値と同じなら true、初期値から変えていれば false" }),
    version: z.number().int().openapi({ description: "変える時に送るバージョン。一度も変えていなければ 0" }),
  })
  .strict()
  .meta({ id: "Setting" });

/** 設定の 1 項目の型 */
export type Setting = z.infer<typeof Setting>;

/** 設定を変える入力。値の形は項目ごとに確かめる */
export const UpdateSettingInput = z
  .object({
    version: z.number().int().openapi({ description: "取得した時点のバージョン。現在と異なる場合は 409 conflict" }),
    value: z.unknown().nonoptional().openapi({ description: "設定ごとの形式。サービスの設定で null を送ると初期値に戻る" }),
    reason: z.string().min(1).max(2000),
  })
  .strict()
  .meta({ id: "UpdateSettingInput" });

/** 設定を変える入力の型 */
export type UpdateSettingInput = z.infer<typeof UpdateSettingInput>;

const Items = z.array(z.string());

/**
 * 設定の変更が守りを弱めるかを見る。弱める変更はパスキーの確認を求める。値は受け継いだ後の実効値で渡す
 * @param key 受け継ぐ項目の名前
 * @param before 今の値
 * @param after 変えた後の値
 * @returns できる操作を足す、条件や触れない所を外す、止めたサービスを動かす時に true
 */
export function weakens(key: InheritedKey, before: unknown, after: unknown): boolean {
  if (key === "paused") return before === true && after === false;
  // 形の分からない値は弱めるとみて、パスキーを求める側に倒す
  const was = Items.safeParse(before);
  const now = Items.safeParse(after);
  if (!was.success || !now.success) return true;
  // できる操作は足すと弱まり、条件と触れない所は外すと弱まる
  return key === "actions" ? grew(was.data, now.data) : grew(now.data, was.data);
}

/**
 * 後の並びに、前の並びに無い物があるかを見る
 * @param from 前の並び
 * @param to 後の並び
 * @returns 増えた物があれば true
 */
function grew(from: readonly string[], to: readonly string[]): boolean {
  const had = new Set(from);
  return to.some((v) => !had.has(v));
}
