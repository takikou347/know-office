// ゲートウェイの設定 (環境変数、秘密、バインディング) を 1 つの形で一度に確かめる。稼働確認が足りない項目の名前だけを返し、デプロイの後の確かめが落とす (ログインと記録の 3.8)
import { RepoName } from "@know-office/core";
import { z } from "zod";

/** 空でない文字 */
const Filled = z.string().trim().min(1);
/** 費用の出る週のバッチ処理と急ぐ故障の調べの切り替え。無ければ off */
const Flag = z.enum(["on", "off"]).optional();
/** バインディングがある事だけを見る */
const Bound = z.custom<object>((value) => typeof value === "object" && value !== null);

/** 主の鍵は 32 バイトを base64 にした物 */
const MasterKey = Filled.refine((value) => {
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
});

/** ゲートウェイが動くのに要る設定の形。オーナーの情報と鍵の値は返さず、名前だけを使う。年ごとの記録の D1 (REC_<年>) は年が来るまで無くてよいので、ここでは見ない */
const GateConfig = z.object({
  DB: Bound,
  FILES: Bound,
  RECORDER: Bound,
  GUARD: Bound,
  STAFF: Bound,
  WORKSPACE: Bound,
  LIVE: Bound,
  ACCESS_TEAM: Filled,
  ACCESS_AUD: Filled,
  OWNER_EMAIL: z.email(),
  MASTER_KEY: MasterKey,
  ANTHROPIC_API_KEY: Filled,
  OFFICE_REPO: RepoName.optional(),
  URGENT_SCAN: Flag,
  IDEA_BATCH: Flag,
  DISTILL_BATCH: Flag,
  FINDINGS_BATCH: Flag,
  EDITOR_WAKE: Flag,
});

/**
 * 設定を一度に確かめ、足りない項目と形の違う項目の名前を返す
 * @param env バインディング。形を知らない物として受け、ここで確かめる
 * @returns 項目の名前を名前の順に並べた物。そろっていれば空
 */
export function checkEnv(env: unknown): string[] {
  const result = GateConfig.safeParse(env);
  if (result.success) return [];
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "")))].filter((name) => name !== "").toSorted();
}
