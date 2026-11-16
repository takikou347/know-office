// Claude の API の鍵を読む。オーナーが入れ直した鍵が vault にあればそれだけを使い、無ければ環境変数の鍵を使う (自動停止の 3.4)
import { AppError, ReplaceClaudeKeyInput, Secret } from "@know-office/core";
import { readStored } from "../auth/vault.ts";
import type { Bindings } from "../env.ts";
import { guardDo } from "../guard/actions.ts";

/**
 * Claude の API の鍵を Secret に包んで読む。vault に一度でも置いた後は、取り消されていても環境変数の鍵に戻らない
 * @param env バインディング
 * @returns 鍵
 * @throws unavailable 鍵が入っていない時、全体を止めた後でまだ入れ直していない時
 */
export async function claudeKey(env: Bindings): Promise<Secret> {
  const stored = await readStored(env.DB, "claude_api_key", env.MASTER_KEY);
  if (stored.top > 0) {
    const parsed = parseKey(stored.value);
    if (parsed === null) throw new AppError("unavailable", "Claude API の鍵を入れ直していない");
    return parsed;
  }
  // 環境変数の鍵は、全体を止めた後は使えない印が付く。入れ直した鍵は vault に入るので、ここへは戻らない
  if (await guardDo(env).keysHeld()) throw new AppError("unavailable", "Claude API の鍵を入れ直していない");
  const key = env.ANTHROPIC_API_KEY ?? "";
  if (key === "") throw new AppError("unavailable", "Claude API の鍵が入っていない");
  return new Secret(key);
}

/**
 * vault の中身を Claude の API の鍵として読む
 * @param value vault の中身 (JSON の文字)
 * @returns 鍵。無いか形が違えば null
 */
function parseKey(value: Secret | null): Secret | null {
  if (value === null) return null;
  try {
    const parsed = ReplaceClaudeKeyInput.safeParse(JSON.parse(value.reveal()));
    return parsed.success ? new Secret(parsed.data.apiKey) : null;
  } catch {
    return null;
  }
}
