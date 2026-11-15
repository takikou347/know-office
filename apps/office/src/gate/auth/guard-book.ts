// ロックアウト、レート制限、パスキーの challenge の数え方。GuardDO が持ち、テストは同じ物を手元の入れ物で使う (ログインと記録の 1.2、3.1 の 4)
import { log } from "@know-office/core";
import { z } from "zod";

/** 数えた物を置く入れ物。DO の ctx.storage と同じ形。読んだ物は Zod で確かめてから使う */
export type GuardStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

/** レート制限の種類。auth はログインセッションの開始とパスキー、workspace はワークスペースの作業トークンの要らないルート、verify は監査ログのハッシュチェーンの確かめ、hook は GitHub の通知 */
export type RateBucket = "api" | "auth" | "workspace" | "verify" | "hook";

/** 入口で通すかの答え。locked ならロックアウト中、retryAfter が数ならレート制限を超えた */
export type Admission = { locked: boolean; retryAfter: number | null };

// challenge は GuardDO の中にだけ置き、API の形にならないので core でなくここに置く
/** パスキーの challenge と、何のために出したか */
export const Challenge = z.object({ challenge: z.string(), purpose: z.enum(["register", "step_up"]) }).strict();

/** パスキーの challenge の型 */
export type Challenge = z.infer<typeof Challenge>;

const StoredChallenge = Challenge.extend({ expiresAt: z.number() });

const MINUTE = 60_000;
/** 1 分に通す数。API の決まりの 1.2 の 3 と 3.6 の 2。workspace はハートビート (30 秒ごと) とチェックポイントの合わせた数。verify は 1 年分を頭から読み直すので 1 回 */
export const RATE_LIMITS: Record<RateBucket, number> = { api: 300, auth: 10, workspace: 60, verify: 1, hook: 60 };
/** この間に LOCK_AFTER 回失敗するとロックアウトする */
const FAIL_WINDOW_MS = 10 * MINUTE;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * MINUTE;
const CHALLENGE_MS = 5 * MINUTE;

/** 通知を出す先。GuardDO は D1 の notices に書く */
export type Notify = (ip: string, at: number) => Promise<void>;

/** 401、403、429 を数える窓の長さ (5 分)。API の決まりの 3.6 の 8 */
export const DENIED_WINDOW_MS = 5 * MINUTE;
/** 窓の中の 401、403、429 がこの回数を超えたら知らせる。API の決まりの 3.6 の 8 */
export const DENIED_LIMIT = 50;

/** 断った数が 5 分に 50 回を超えた時に知らせる先。数は超えた時の窓の数 */
export type NotifyDenied = (at: number, count: number) => Promise<void>;

/** 送信元ごとの失敗とロックアウト、レート制限、challenge を数える */
export class GuardBook {
  // レート制限の数は 1 分で消えるので、DO が起き直したら数え直してよい。記憶にだけ持つ
  #counts = new Map<string, number>();
  /** #counts を数えている分の始まり */
  #minute = 0;
  // 断った数は 1 分ごとに区切り、5 分の分だけ持つ。DO が起き直したら数え直してよい
  #denied = new Map<number, number>();

  /**
   * @param storage ロックアウトと challenge を置く入れ物
   * @param notify ロックアウトした時に通知を出す
   * @param notifyDenied 断った数が 5 分に 50 回を超えた時に通知を出す
   */
  constructor(
    private readonly storage: GuardStorage,
    private readonly notify: Notify,
    private readonly notifyDenied: NotifyDenied = () => Promise.resolve(),
  ) {}

  /**
   * 断った数を持っている分の数。記憶が増え続けない事をテストで確かめる
   * @returns 分の数
   */
  get deniedMinutes(): number {
    return this.#denied.size;
  }

  /**
   * 401、403、429 を 1 回数える。5 分の窓の数が 50 を超えた 1 回目だけ知らせる。知らせが書けなくても投げない
   * 窓は 1 分ごとの 5 つの数で持つので、境目では最大 1 分ぶん長く数える
   * @param now 今の時刻
   * @returns 無し
   */
  async countDenied(now: number): Promise<null> {
    const minute = now - (now % MINUTE);
    for (const key of this.#denied.keys()) if (key <= minute - DENIED_WINDOW_MS) this.#denied.delete(key);
    this.#denied.set(minute, (this.#denied.get(minute) ?? 0) + 1);
    let count = 0;
    for (const n of this.#denied.values()) count += n;
    // 数えるのも比べるのも待たずに続けるので、同じ時に来ても超えた 1 回目は 1 つだけ
    if (count === DENIED_LIMIT + 1) {
      await this.notifyDenied(now, count).catch((error: unknown) => log("warn", "denied_notice_failed", { error: error instanceof Error ? error.message : "unknown" }));
    }
    return null;
  }

  /**
   * 今の分で数えている送信元と種類の組の数。記憶が増え続けない事をテストで確かめる
   * @returns 組の数
   */
  get tracked(): number {
    return this.#counts.size;
  }

  /**
   * 入口で通すかを決める。ロックアウト中か、1 分の数を超えたかを見る
   * @param ip 送信元
   * @param bucket レート制限の種類
   * @param now 今の時刻
   * @param count 断った時に、401、403、429 の数に入れるか。/api/v1/ と /ws/v1/ のほか (GitHub の通知) は入れない
   * @returns ロックアウト中か、待つ秒数
   */
  async admit(ip: string, bucket: RateBucket, now: number, count = true): Promise<Admission> {
    const until = z.number().optional().parse(await this.storage.get(`lock:${ip}`));
    if (until !== undefined && until > now) {
      // 断る 403 はここで数え、入口のミドルウェアでは数えない
      if (count) await this.countDenied(now);
      return { locked: true, retryAfter: null };
    }
    // 1 分ごとに区切って数える。区切りの境目で最大 2 倍通るが、守りたいのは総当たりの速さなので足りる
    const start = now - (now % MINUTE);
    // 分が変わったら前の分の数は要らないので、送信元ごと捨てる。記憶が送信元の数だけ増え続けない
    if (start !== this.#minute) {
      this.#counts.clear();
      this.#minute = start;
    }
    const key = `${bucket}:${ip}`;
    const used = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, used);
    if (used <= RATE_LIMITS[bucket]) return { locked: false, retryAfter: null };
    // 429 はここで数える。断る要求ごとに DO を呼び足さない
    if (count) await this.countDenied(now);
    return { locked: false, retryAfter: Math.ceil((start + MINUTE - now) / 1000) };
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
