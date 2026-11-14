// 1 行の JSON のログ。Workers Logs に残る。鍵や作業トークンは伏せる (ログインと記録の 3.8)
const SECRET_KEY = /authorization|cookie|token|secret|key|password/i;
// 文の中に混じった鍵らしい物。上から順に置き換える。値だけを伏せ、何を伏せたかは名前で分かるようにする
const SECRET_TEXT: [RegExp, string][] = [
  // ヘッダーの行は値に空白や ; を含むので、行の終わりまで伏せる
  [/\b(authorization|proxy-authorization|cookie|set-cookie)("?\s*[:=]\s*)[^\n]*/gi, "$1$2[伏せた]"],
  [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [伏せた]"],
  // GitHub と Anthropic の鍵の頭。名前が付いていなくても形で分かる
  [/\b(?:gh[pousr]_|github_pat_|sk-ant-)[\w-]+/g, "[伏せた]"],
  // 名前=値、名前: 値、JSON の "名前":"値"
  [/(\b[\w-]*(?:token|secret|key|password)[\w-]*"?\s*[:=]\s*"?)(?!\[伏せた\])[^\s",;&}]+/gi, "$1[伏せた]"],
];

/**
 * 文の中の鍵らしい所を伏せる
 * @param text 文
 * @returns 伏せた文
 */
export function redactText(text: string): string {
  return SECRET_TEXT.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/**
 * 値の中の鍵らしい項目と文を伏せる
 * @param value ログに出す値
 * @returns 伏せた値
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[伏せた]" : redact(v)]));
  }
  return value;
}

/**
 * 1 行の JSON をログに出す。warn と error は console の同じ名前の出口に出す
 * @param level request、info、warn、error
 * @param event 出来事の名前
 * @param fields 一緒に出す項目。traceId を入れる
 */
export function log(level: "request" | "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify(redact({ level, event, ...fields }));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
