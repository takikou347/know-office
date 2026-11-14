// ロックアウト、レート制限、パスキーの challenge の数え方。GuardDO が持ち、テストは同じ物を手元の入れ物で使う (ログインと記録の 1.2、3.1 の 4)
import { z } from "zod";

/** 数えた物を置く入れ物。DO の ctx.storage と同じ形。読んだ物は Zod で確かめてから使う */
export type GuardStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

/** レート制限の種類。auth はログインセッションの開始とパスキー */
export type RateBucket = "api" | "auth";

/** 入口で通すかの答え。locked ならロックアウト中、retryAfter が数ならレート制限を超えた */
export type Admission = { locked: boolean; retryAfter: number | null };

/** パスキーの challenge と、何のために出したか */
export const Challenge = z.object({ challenge: z.string(), purpose: z.enum(["register", "step_up"]) }).strict();

/** パスキーの challenge の型 */
export type Challenge = z.infer<typeof Challenge>;

const StoredChallenge = Challenge.extend({ expiresAt: z.number() });

const MINUTE = 60_000;
/** 1 分に通す数。API の決まりの 1.2 の 3 と 3.6 の 2 */
export const RATE_LIMITS: Record<RateBucket, number> = { api: 300, auth: 10 };
/** この間に LOCK_AFTER 回失敗するとロックアウトする */
const FAIL_WINDOW_MS = 10 * MINUTE;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * MINUTE;
const CHALLENGE_MS = 5 * MINUTE;

/** 通知を出す先。GuardDO は D1 の notices に書く */
export type Notify = (ip: string, at: number) => Promise<void>;

/** 送信元ごとの失敗とロックアウト、レート制限、challenge を数える */
export class GuardBook {
  // レート制限の数は 1 分で消えるので、DO が起き直したら数え直してよい。記憶にだけ持つ
  #windows = new Map<string, { start: number; count: number }>();

  /**
   * @param storage ロックアウトと challenge を置く入れ物
   * @param notify ロックアウトした時に通知を出す
   */
  constructor(
    private readonly storage: GuardStorage,
    private readonly notify: Notify,
  ) {}

  /**
   * 入口で通すかを決める。ロックアウト中か、1 分の数を超えたかを見る
   * @param ip 送信元
   * @param bucket レート制限の種類
   * @param now 今の時刻
   * @returns ロックアウト中か、待つ秒数
   */
  async admit(ip: string, bucket: RateBucket, now: number): Promise<Admission> {
    const until = z.number().optional().parse(await this.storage.get(`lock:${ip}`));
    if (until !== undefined && until > now) return { locked: true, retryAfter: null };
    // 1 分ごとに区切って数える。区切りの境目で最大 2 倍通るが、守りたいのは総当たりの速さなので足りる
    const key = `${bucket}:${ip}`;
    const start = now - (now % MINUTE);
    const window = this.#windows.get(key);
    const current = window?.start === start ? window : { start, count: 0 };
    current.count += 1;
    this.#windows.set(key, current);
    if (current.count > RATE_LIMITS[bucket]) return { locked: false, retryAfter: Math.ceil((start + MINUTE - now) / 1000) };
    return { locked: false, retryAfter: null };
  }

  /**
   * ログインの証明かパスキーの失敗を 1 回数える。10 分に 5 回で 15 分ロックアウトし、通知を出す
   * @param ip 送信元
   * @param now 今の時刻
   * @returns この失敗でロックアウトしたか
   */
  async fail(ip: string, now: number): Promise<{ locked: boolean }> {
    const recent = (z.array(z.number()).optional().parse(await this.storage.get(`fail:${ip}`)) ?? []).filter((at) => at > now - FAIL_WINDOW_MS);
    recent.push(now);
    if (recent.length < LOCK_AFTER) {
      await this.storage.put(`fail:${ip}`, recent);
      return { locked: false };
    }
    await this.storage.put(`lock:${ip}`, now + LOCK_MS);
    await this.storage.delete(`fail:${ip}`);
    await this.notify(ip, now);
    return { locked: true };
  }

  /**
   * ログインセッションに challenge を 5 分だけ結ぶ。前の challenge は置き換える
   * @param sessionId ログインセッションの ID
   * @param challenge challenge と目的
   * @param now 今の時刻
   * @returns 無し
   */
  async putChallenge(sessionId: string, challenge: Challenge, now: number): Promise<null> {
    await this.storage.put(`challenge:${sessionId}`, { ...challenge, expiresAt: now + CHALLENGE_MS });
    return null;
  }

  /**
   * challenge を取り出して消す。同じ challenge を 2 度使わせない
   * @param sessionId ログインセッションの ID
   * @param now 今の時刻
   * @returns 期限の内なら challenge、無いか切れていれば null
   */
  async takeChallenge(sessionId: string, now: number): Promise<Challenge | null> {
    const stored = StoredChallenge.optional().parse(await this.storage.get(`challenge:${sessionId}`));
    await this.storage.delete(`challenge:${sessionId}`);
    if (!stored || stored.expiresAt < now) return null;
    return { challenge: stored.challenge, purpose: stored.purpose };
  }
}
