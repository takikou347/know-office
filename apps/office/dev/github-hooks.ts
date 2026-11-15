// 開発環境の代わりの GitHub が送る通知。GitHub と同じヘッダー、署名、時刻の入った配信 ID で送る
import { createHmac } from "node:crypto";

/**
 * GitHub の配信 ID と同じ、時刻の入った UUID (版 1) を作る。RFC 9562 の 5.1
 * @param at 時刻 (協定世界時のミリ秒)
 * @returns 配信 ID
 */
export function deliveryId(at: number): string {
  // 1582-10-15 からの 100 ナノ秒の数
  const ticks = BigInt(at) * 10_000n + 0x01b21dd213814000n;
  const low = (ticks & 0xffffffffn).toString(16).padStart(8, "0");
  const mid = ((ticks >> 32n) & 0xffffn).toString(16).padStart(4, "0");
  const high = (((ticks >> 48n) & 0x0fffn) | 0x1000n).toString(16).padStart(4, "0");
  const rest = crypto.getRandomValues(new Uint8Array(8));
  rest[0] = ((rest[0] ?? 0) & 0x3f) | 0x80;
  const hex = [...rest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${low}-${mid}-${high}-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** 代わりの GitHub が送る通知 */
export type WebhookOptions = {
  /** 送り先 */
  url: string;
  /** X-GitHub-Event の値 */
  event: string;
  /** 本文 */
  payload: unknown;
  /** 署名の鍵 */
  secret: string;
  /** X-GitHub-Delivery の値。無ければ今の時刻の配信 ID */
  delivery?: string;
  /** 送る関数。初期値は fetch */
  fetcher?: (req: Request) => Promise<Response>;
};

/**
 * GitHub と同じヘッダーと署名で通知を送る
 * @param options 送り先、種類、本文、署名の鍵
 * @returns 送り先の返事
 */
export function sendWebhook(options: WebhookOptions): Promise<Response> {
  const body = JSON.stringify(options.payload);
  const signature = `sha256=${createHmac("sha256", options.secret).update(body).digest("hex")}`;
  const req = new Request(options.url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event,
      "x-github-delivery": options.delivery ?? deliveryId(Date.now()),
      "x-hub-signature-256": signature,
    },
  });
  return (options.fetcher ?? fetch)(req);
}
