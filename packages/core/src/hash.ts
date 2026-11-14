// ハッシュと、ハッシュを取る前の JSON の正規化。監査ログのハッシュチェーンに使う (データの 3.3)

/**
 * キーを並べ替えた JSON にする。同じ中身なら同じ文字列になる
 * @param value JSON にできる値
 * @returns 正規化した JSON
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      // localeCompare は言語で順が変わるので、コード単位の順で並べる
      .toSorted(([a], [b]) => Number(a > b) - Number(a < b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 を 16 進数で返す
 * @param text UTF-8 の文字列
 * @returns 64 桁の 16 進数
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
