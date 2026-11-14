// 外への fetch の出口。決めた宛先だけを、時間を切って呼ぶ (API の決まりの 3.6 の 6)

/** fetch と同じ形の関数。テストは代わりの物を渡す */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** 外を呼ぶ時の初期の待ち時間 (10 秒)。コード規約の「外を呼ぶ時」 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * 決めた宛先の下の URL だけを呼ぶ。利用者の入力から作った URL を外へ出さない
 * @param fetcher 呼ぶ関数。本番は globalThis.fetch
 * @param url 呼ぶ URL
 * @param allowed 呼んでよい宛先の頭 (例: https://api.github.com/)
 * @param init fetch の設定。signal が無ければ 10 秒で切る
 * @returns 返事
 * @throws Error 宛先が allowed に無い時
 */
export function allowedFetch(fetcher: Fetcher, url: string, allowed: readonly string[], init: RequestInit = {}): Promise<Response> {
  // 頭の文字列で比べるので、宛先は必ずパスの区切りまで書かせる (https://a.com と https://a.com.evil の取り違えを防ぐ)
  const ok = allowed.some((prefix) => prefix.endsWith("/") && url.startsWith(prefix));
  if (!ok) return Promise.reject(new Error("決めた宛先でない fetch"));
  return fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}
