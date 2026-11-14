// 全体のセキュリティ DO。ロックアウト、レート制限、パスキーの challenge を 1 か所で数える (ログインと記録の 1.2)
import { DurableObject } from "cloudflare:workers";
import { newId, systemClock } from "@know-office/core";
import { type Admission, type Challenge, GuardBook, type RateBucket } from "../auth/guard-book.ts";
import type { Bindings, Guard } from "../env.ts";

/** 全体のセキュリティ DO。ゲートウェイだけが RPC で呼ぶ。時刻は呼ぶ側の Clock で渡す */
export class GuardDO extends DurableObject<Bindings> implements Guard {
  #book = new GuardBook(this.ctx.storage, async (ip, at) => {
    await this.env.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES (?, ?, 'warn', 'lockout', ?, ?, 'office')")
      .bind(newId(systemClock), at, "ログインの失敗が続いたため送信元を 15 分止めた", `送信元 ${ip} が 10 分に 5 回失敗した`)
      .run();
  });

  /**
   * 入口で通すかを決める
   * @param ip 送信元
   * @param bucket レート制限の種類
   * @param now 今の時刻
   * @returns ロックアウト中か、待つ秒数
   */
  admit(ip: string, bucket: RateBucket, now: number): Promise<Admission> {
    return this.#book.admit(ip, bucket, now);
  }

  /**
   * 失敗を 1 回数える
   * @param ip 送信元
   * @param now 今の時刻
   * @returns この失敗でロックアウトしたか
   */
  fail(ip: string, now: number): Promise<{ locked: boolean }> {
    return this.#book.fail(ip, now);
  }

  /**
   * challenge をログインセッションに結ぶ
   * @param sessionId ログインセッションの ID
   * @param challenge challenge と目的
   * @param now 今の時刻
   * @returns 無し
   */
  putChallenge(sessionId: string, challenge: Challenge, now: number): Promise<null> {
    return this.#book.putChallenge(sessionId, challenge, now);
  }

  /**
   * challenge を取り出して消す
   * @param sessionId ログインセッションの ID
   * @param now 今の時刻
   * @returns 期限の内なら challenge
   */
  takeChallenge(sessionId: string, now: number): Promise<Challenge | null> {
    return this.#book.takeChallenge(sessionId, now);
  }
}
