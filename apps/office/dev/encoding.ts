// 代わりの物が使う base64url の書き方
/**
 * バイト列を base64url にする
 * @param bytes バイト列
 * @returns パディングの無い base64url
 */
export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString("base64url");
}

/**
 * 文字列を UTF-8 の base64url にする
 * @param text 文字列
 * @returns パディングの無い base64url
 */
export function base64urlText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
