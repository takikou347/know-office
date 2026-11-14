// base64 と base64url の変換。外から来た文字列は壊れていても投げず null を返し、呼ぶ側が断る
// 組を繰り返す形は、長い文字列で正規表現の戻りが積もって投げるので、長さは別に 4 の倍数かを見る
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
/** toBase64 が 1 度に文字にするバイトの数 */
const BASE64_SLICE = 0x8000;

/**
 * バイト列を base64 にする
 * @param data バイト列
 * @returns パディングの付いた base64
 */
export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(data);
  // 引数に広げられる数には上限があるので、会話の記録のような大きな物は区切って文字にする
  let text = "";
  for (let at = 0; at < bytes.length; at += BASE64_SLICE) text += String.fromCharCode(...bytes.subarray(at, at + BASE64_SLICE));
  return btoa(text);
}

/**
 * base64 をバイト列に戻す
 * @param text base64
 * @returns バイト列。形が違えば null
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  // atob は形が違うと同期で投げるので、先に形を確かめる
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

/**
 * バイト列を base64url にする。RFC 4648 の 5 章
 * @param data バイト列
 * @returns パディングの無い base64url
 */
export function toBase64url(data: ArrayBuffer | Uint8Array): string {
  return toBase64(data).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * base64url をバイト列に戻す
 * @param text パディングの無い base64url
 * @returns バイト列。形が違えば null
 */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  // 4 で割って 1 余る長さは、どのバイト列からも作れない
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return fromBase64(padded);
}
