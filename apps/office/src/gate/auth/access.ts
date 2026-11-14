// Cloudflare Access のログインの証明を確かめる。ログインと記録の 3.1、API の決まりの 3.6 の 3
import { allowedFetch, AppError, type Clock, type Fetcher } from "@know-office/core";
import { createLocalJWKSet, errors, type JSONWebKeySet, jwtVerify } from "jose";
import { z } from "zod";

/** 証明を確かめるのに使う設定 */
export type AccessConfig = {
  /** Access の公開鍵の URL */
  certsUrl: string;
  /** Access のチーム名。iss に入る */
  team: string;
  /** アプリの宛先 (aud) */
  aud: string;
  /** オーナーのメールアドレス */
  ownerEmail: string;
};

const Certs = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) });
const Claims = z.looseObject({ email: z.string() });

/** 公開鍵をためておく時間。ログインと記録の 3.1 の 2 */
const CACHE_MS = 60 * 60_000;
/** 知らない kid で取り直す間の最短。証明を作れない人が取り直しを繰り返させて Access に負荷をかけるのを防ぐ */
const REFETCH_MS = 30_000;

/** ためた公開鍵と、最後に取りに行って失敗した時刻 */
type CertsCache = { at: number; keys: JSONWebKeySet } | { failedAt: number };

// isolate の中で公開鍵をためる。fetch と URL ごとに持つので、開発環境と本番や、テストごとの代わりの Access が混ざらない
const caches = new WeakMap<Fetcher, Map<string, CertsCache>>();

/**
 * 公開鍵を読む。ためた物が古いか、force の時だけ取り直す
 * @param fetcher 外への fetch
 * @param url 公開鍵の URL
 * @param clock 時刻
 * @param force 知らない kid が来た時に取り直すか
 * @returns 公開鍵の一覧
 * @throws unavailable 公開鍵を読めない時と、読めなかった後の 30 秒。断る側に倒すので証明は通らない
 */
async function certs(fetcher: Fetcher, url: string, clock: Clock, force: boolean): Promise<JSONWebKeySet> {
  const now = clock.now();
  const cache = caches.get(fetcher) ?? new Map<string, CertsCache>();
  caches.set(fetcher, cache);
  const cached = cache.get(url);
  // Access が落ちている間に、証明の付いた要求ごとに取りに行かない
  if (cached && "failedAt" in cached && now - cached.failedAt < REFETCH_MS) throw new AppError("unavailable", "Access の公開鍵を読めない");
  if (cached && "keys" in cached && now - cached.at < (force ? REFETCH_MS : CACHE_MS)) return cached.keys;
  try {
    const keys = await fetchCerts(fetcher, url);
    cache.set(url, { at: now, keys });
    return keys;
  } catch (error) {
    cache.set(url, { failedAt: now });
    throw error;
  }
}

/**
 * Access から公開鍵を取り、形を確かめる
 * @param fetcher 外への fetch
 * @param url 公開鍵の URL
 * @returns 公開鍵の一覧
 * @throws unavailable 届かない、200 でない、形が違う時
 */
async function fetchCerts(fetcher: Fetcher, url: string): Promise<JSONWebKeySet> {
  // 宛先は endpoints() が環境変数から決めた物だけで、要求の中身から作らない
  const res = await allowedFetch(fetcher, url, [`${new URL(url).origin}/`]).catch(() => null);
  if (!res?.ok) throw new AppError("unavailable", "Access の公開鍵を読めない");
  const parsed = Certs.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new AppError("unavailable", "Access の公開鍵の形が違う");
  return { keys: parsed.data.keys };
}

/**
 * 証明の署名、発行者、宛先、期限を確かめ、メールアドレスを返す
 * @param token Cf-Access-Jwt-Assertion の値
 * @param config 公開鍵の URL、チーム名、宛先、オーナー
 * @param fetcher 外への fetch
 * @param clock 時刻
 * @returns オーナーのメールアドレス
 * @throws unauthenticated 証明が無い、署名、発行者、宛先、期限が合わない時
 * @throws forbidden 証明は正しいがオーナーでない時
 */
export async function verifyAccess(token: string | undefined, config: AccessConfig, fetcher: Fetcher, clock: Clock): Promise<string> {
  if (!token) throw new AppError("unauthenticated", "ログインの証明が無い");
  const options = {
    // Access の証明は RS256 だけ。alg を決めて、none や HS256 にすり替えた証明を断る
    algorithms: ["RS256"],
    issuer: `https://${config.team}.cloudflareaccess.com`,
    audience: config.aud,
    currentDate: new Date(clock.now()),
  };
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, createLocalJWKSet(await certs(fetcher, config.certsUrl, clock, false)), options));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (!(error instanceof errors.JWKSNoMatchingKey)) throw new AppError("unauthenticated", "ログインの証明が合わない");
    // 鍵を取り替えた直後は新しい kid を知らないので、1 度だけ取り直す
    try {
      ({ payload } = await jwtVerify(token, createLocalJWKSet(await certs(fetcher, config.certsUrl, clock, true)), options));
    } catch (retry) {
      if (retry instanceof AppError) throw retry;
      throw new AppError("unauthenticated", "ログインの証明が合わない");
    }
  }
  const claims = Claims.safeParse(payload);
  if (!claims.success) throw new AppError("unauthenticated", "ログインの証明にメールアドレスが無い");
  // Google のメールアドレスは大文字と小文字を区別しない
  if (claims.data.email.toLowerCase() !== config.ownerEmail.toLowerCase()) throw new AppError("forbidden", "オーナーでない");
  return claims.data.email;
}
