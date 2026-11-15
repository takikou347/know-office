// 配信の作業トークンの本。60 秒のうちに 1 回だけ使える。LiveDO の同期の記憶に置き、テストは手元の入れ物で使う (社員と自動の 3.7)
import { AppError, sha256Hex, toBase64url } from "@know-office/core";
import { z } from "zod";

/** 作業トークンの使える長さ。出した時刻からこの長さちょうどで使えなくなる */
export const LIVE_TICKET_MS = 60_000;

/** 同時に使える作業トークンの数の上限 */
export const LIVE_TICKET_LIMIT = 20;

/** 作業トークンの形。32 バイトの乱数の base64url (43 字) */
export const LiveTicketValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** 作業トークンを置く記憶。SQLite の DO の ctx.storage.kv と同じ同期の形 */
export type TicketStorage = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list(options: { prefix: string }): Iterable<[string, unknown]>;
};

const PREFIX = "ticket:";
const Expiry = z.number().int();

/** 配信の作業トークンを出し、1 回だけ使わせる */
export class LiveTickets {
  readonly #storage: TicketStorage;

  /**
   * 本を作る
   * @param storage 同期の記憶
   */
  constructor(storage: TicketStorage) {
    this.#storage = storage;
  }

  /**
   * 切れた作業トークンを捨ててから、新しい作業トークンを出す。記憶には作業トークンそのものでなく SHA-256 を置く
   * @param now 今の時刻
   * @returns 作業トークンと切れる時刻
   * @throws rate_limited 使える作業トークンが上限まである時
   */
  async issue(now: number): Promise<{ ticket: string; expiresAt: string }> {
    const ticket = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256Hex(ticket);
    // ハッシュを作った後は await を挟まず、数えてから置くまでの間にほかの呼び出しを入れない
    let live = 0;
    for (const [key, value] of this.#storage.list({ prefix: PREFIX })) {
      const expiry = Expiry.safeParse(value);
      if (expiry.success && now < expiry.data) live += 1;
      else this.#storage.delete(key);
    }
    if (live >= LIVE_TICKET_LIMIT) throw new AppError("rate_limited", "使える配信の作業トークンが多すぎる");
    const expiresAt = now + LIVE_TICKET_MS;
    this.#storage.put(`${PREFIX}${hash}`, expiresAt);
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * 作業トークンを使った事にする。形が違う、無い、使った、切れた物は断る
   * @param ticket 作業トークン
   * @param now 今の時刻
   * @returns 使えたら true
   */
  async redeem(ticket: string, now: number): Promise<boolean> {
    if (!LiveTicketValue.safeParse(ticket).success) return false;
    const key = `${PREFIX}${await sha256Hex(ticket)}`;
    // 読んでから消すまでに await を挟まないので、同時に 2 つ来ても使えるのは 1 つだけ
    const expiry = Expiry.safeParse(this.#storage.get(key));
    if (!this.#storage.delete(key)) return false;
    return expiry.success && now < expiry.data;
  }
}
