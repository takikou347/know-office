// 1 行の JSON のログ。Workers Logs に残る。鍵や作業トークンは伏せる (ログインと記録の 3.8)
const SECRET_KEY = /authorization|cookie|token|secret|key|password/i;
// 文の中に混じった鍵らしい物。名前=値、名前: 値、よく知られた鍵の頭
const SECRET_TEXT = [/\b(authorization|cookie|token|secret|key|password)\b\s*[:=]\s*\S+/gi, /\b(gh[pousr]_|sk-ant-|Bearer\s+)[\w.-]+/g];

/**
 * 文の中の鍵らしい所を伏せる
 * @param text 文
 * @returns 伏せた文
 */
export function redactText(text: string): string {
  return SECRET_TEXT.reduce((out, pattern) => out.replace(pattern, (m: string) => `${m.split(/[:=\s]/)[0] ?? ""}[伏せた]`), text);
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
