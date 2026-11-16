// アイデアとサービスの画面の、段階、種類、出来事の名前とお金の書き方
import type { ServiceKind, ServiceStage } from "@know-office/core";

/** 段階の名前。一覧はこの順に並べる */
export const STAGE_LABEL: Record<ServiceStage, string> = {
  idea: "アイデア",
  study: "検討",
  prototype: "試作",
  service: "サービス",
  operation: "運用",
  dropped: "見送った",
  closed: "閉じた",
};

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

/** 種類の名前 */
export const KIND_LABEL: Record<ServiceKind, string> = { library: "ライブラリ", web_app: "Web アプリ", content: "コンテンツ" };

/** 出来事の種類の名前 */
export const EVENT_LABEL: Record<string, string> = { stage: "段階", deploy: "デプロイ", rollback: "前のバージョンに戻した", release: "公開", uses: "使う版" };

/**
 * 100 万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.23 ドル」
 */
export const dollars = (micro: number): string => `${(micro / 1_000_000).toFixed(2)} ドル`;
