// 自動停止が外へ頼む口と、DO が返す数えた答えの形 (自動停止の 3.4、3.6)
import { type Judgment, newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { notices } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { revokeTokens, SHARED_TOKENS } from "../github/app.ts";
import { auditFrom } from "../ledger/record.ts";
import { rollbackService } from "../services/rollback.ts";
import { clockAt } from "../work/attendance.ts";
import type { Forge } from "../work/loop.ts";

/** 直前の出来事 1 件。出来事の項目はどれも文字、数、真偽、null */
export type RecentOp = Record<string, string | number | boolean | null>;

/** DO が数えた答え。止める時の記録に使う、直前の操作と読んだ外部の文章の出所を添える */
export type Observed = Judgment & {
  /** 直前の 20 件の出来事。古い順 */
  recentOps: RecentOp[];
  /** その出来事のタスクが読んだ外部の文章の出所 */
  externalSources: string[];
};

/** レビュー担当に渡す、止めた記録 */
export type StopRecord = {
  /** 止めた記録の ID */
  stopId: string;
  /** 範囲 */
  scope: "task" | "staff";
  /** 相手 */
  target: string;
  /** 当たったシグナル */
  signal: string;
  /** 数えた値 */
  measured: number;
  /** その時の基準 */
  threshold: number;
  /** 直前の 20 件の出来事 */
  recentOps: RecentOp[];
};

/** レビュー担当の答え。resume が true なら再開する */
export type ReviewAnswer = { resume: boolean; reason: string };

/** 自動停止が外へ頼む口。GitHub とレビュー担当のモデルは後でつなぐ */
export type GuardDeps = {
  /** Web アプリを前のバージョンに戻す。そのリポジトリの rollback.yml を、止めた記録ごとに 1 度だけ動かす */
  rollback(serviceId: string, stopId: string): Promise<void>;
  /** 止めた記録をレビュー担当に渡し、理由を確かめさせる。答えが無ければ null */
  review(record: StopRecord): Promise<ReviewAnswer | null>;
  /** ためた GitHub の 1 時間の鍵を GitHub の側で取り消し、ためる所を空にする */
  revokeGitHubTokens(env: Bindings): Promise<void>;
};

/** まだつないでいない口。戻しは失敗として返し、止めた側が通知とエラーログに残す。レビュー担当は答えず、再開はオーナーが行う。入口と定期ジョブは戻しを connectRollback でつなぐ */
// TODO(#48): review を 7 章のモデルの呼び出しにつなぐ
export const UNCONNECTED_DEPS: GuardDeps = {
  rollback: () => Promise.reject(new Error("rollback.yml をまだつないでいない")),
  review: () => Promise.resolve(null),
  revokeGitHubTokens: (env) => revokeTokens(env, { fetcher: (input, init) => fetch(input, init), cache: SHARED_TOKENS }),
};

/**
 * 自動停止の戻しを GitHub の rollback.yml につないだ口を作る。直前に戻していれば送らず、飛ばした事を監査ログと通知に残す
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param now 今の時刻を返す関数
 * @returns GuardDeps の rollback
 */
export function connectRollback(env: Bindings, forge: Forge, now: () => number): GuardDeps["rollback"] {
  return async (serviceId, stopId) => {
    const at = now();
    const sent = await rollbackService(env, forge, { serviceId, by: "system", reason: "自動停止がサービスを止めた", stopId, now: at });
    if (sent) return;
    // 直前に戻したか、同じ止めた記録で戻した後なので送らなかった。オーナーが飛ばした事を見られるよう残す
    await auditFrom(env, { at, actor: "system", action: "service.rollback_skipped", target: serviceId, scope: serviceId, detail: { stopId } });
    await drizzle(env.DB)
      .insert(notices)
      .values({ id: newId(clockAt(at)), at, level: "warn", kind: "service_rollback_skipped", title: "自動停止の戻しを飛ばした", body: "直前に戻したか、同じ止めた記録で戻した後なので、rollback.yml を動かさなかった", scope: serviceId });
  };
}
