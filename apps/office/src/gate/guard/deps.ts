// 自動停止が外へ頼む口と、DO が返す数えた答えの形 (自動停止の 3.4、3.6)
import { type Judgment, log } from "@know-office/core";

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
  /** Web アプリを前のバージョンに戻す。そのリポジトリの rollback.yml を動かす */
  rollback(serviceId: string): Promise<void>;
  /** 止めた記録をレビュー担当に渡し、理由を確かめさせる。答えが無ければ null */
  review(record: StopRecord): Promise<ReviewAnswer | null>;
};

/** まだつないでいない口。GitHub (tasks.md の 8 章) とレビュー担当のモデル (7 章) をつなぐまで、戻せなかった事を記録に残し、再開はオーナーが行う */
export const UNCONNECTED_DEPS: GuardDeps = {
  rollback: (serviceId) => {
    log("warn", "guard_rollback_unconnected", { serviceId });
    return Promise.resolve();
  },
  review: () => Promise.resolve(null),
};
