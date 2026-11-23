// アイデアとサービスの画面の、段階を移すボタンと出来事の名前、お金の書き方、値が無い時の文。段階と種類の名前はマスタデータ
import type { ServiceStage } from "@know-office/core";

/** 段階を移すボタンの文 */
export const MOVE_LABEL: Record<ServiceStage, string> = {
  idea: "アイデアに戻す",
  study: "検討に進める",
  prototype: "作ると決める",
  service: "サービスにする",
  operation: "運用に入る",
  dropped: "見送る",
  closed: "閉じる",
};

/** 出来事の種類の名前 */
export const EVENT_LABEL: Record<string, string> = { stage: "段階", deploy: "デプロイ", rollback: "前のバージョンに戻した", release: "公開", uses: "使う版" };

/**
 * 100 万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.23 ドル」
 */
export const dollars = (micro: number): string => `${(micro / 1_000_000).toFixed(2)} ドル`;

/** 値が無い項目に出す文 */
export const UNSET = "未設定";

/** 選び肢の「その他」の値。選ぶと理由を書く欄が出る */
export const OTHER_REASON = "__other__";
