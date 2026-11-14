// MASTER_KEY から用途ごとの暗号の鍵を作る。鍵は用途ごとに分け、1 つが漏れても他を守る (04-detail.md の 3.5)
import { AppError } from "./errors.ts";

/** 鍵の用途。vault は実行中に作る鍵の暗号、transcript は会話の記録、owner-data はオーナーの情報 */
export type KeyPurpose = "vault" | "transcript" | "owner-data";

/**
 * MASTER_KEY から用途の AES-GCM の鍵を HKDF-SHA256 で作る
 * @param master MASTER_KEY。32 バイトを base64 で
 * @param purpose 用途。HKDF の info に入れる
 * @returns AES-GCM の 256 ビットの鍵
 * @throws internal MASTER_KEY が 32 バイトでない時
 */
export async function deriveKey(master: string, purpose: KeyPurpose): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(master), (ch) => ch.charCodeAt(0));
  if (raw.length !== 32) throw new AppError("internal", "MASTER_KEY が 32 バイトでない");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`know-office:${purpose}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
