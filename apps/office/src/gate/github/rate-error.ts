// GitHub のレート制限に当たった事を表す失敗。ほかを読まないので、低い所 (github/app.ts) からも循環なしに使える
import { AppError } from "@know-office/core";

/** ゲートウェイが GitHub を呼んでレート制限に当たった時に投げる 429。onError が見分けて通知を出す */
export class GitHubRateLimited extends AppError {
  /**
   * @param seconds 送り直してよいまでの秒
   */
  constructor(readonly seconds: number) {
    super("rate_limited", "GitHub の上限に届いた", { headers: { "Retry-After": String(seconds) } });
  }
}
