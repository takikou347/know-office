// 1 行の JSON のログ。Workers Logs に残る。鍵や作業トークンは伏せる (ログインと記録の 3.6)
const SECRET_KEY = /authorization|cookie|token|secret|key|password/i;
// 文の中に混じった鍵らしい物。上から順に置き換える。値だけを伏せ、何を伏せたかは名前で分かるようにする
const SECRET_TEXT: [RegExp, string][] = [
  // ヘッダーの行は値に空白や ; を含むので、行の終わりまで伏せる
  [/\b(authorization|proxy-authorization|cookie|set-cookie)("?\s*[:=]\s*)[^\n]*/gi, "$1$2[伏せた]"],
  [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [伏せた]"],
  // 作業トークン (JWT)。署名の無い 2 つの部分だけでも伏せる
  [/eyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "[伏せた]"],
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

// 外 (GitHub の Issue) に出す文で、鍵に加えて伏せる物。上から順に置き換える
const PUBLIC_TEXT: [RegExp, string][] = [
  // URL の userinfo (user:pass@)
  [/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[伏せた]@"],
  // Bearer の後の値は短くても、: や = で区切られていても伏せる
  [/\b(Bearer)(?:\s*[:=]\s*|\s+)(?!\[伏せた\])[^\s"',;]+/gi, "$1 [伏せた]"],
  // 鍵の頭は語の途中に埋まっていても伏せる
  [/(?:gh[pousr]_|github_pat_|sk-ant-)[\w-]+/g, "[伏せた]"],
  [/\bsk-[\w-]+/g, "[伏せた]"],
  [/AKIA[\dA-Z]{16}/g, "[伏せた]"],
  [/xox[bp]-[\w-]+/g, "[伏せた]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[伏せた]"],
  [/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, "[伏せた]"],
  // トレース ID、ハッシュ、鍵の ID。16 桁より短い物 (コミットの短い形) は残す
  [/\b[\da-f]{16,}\b/gi, "[伏せた]"],
  // 数字と英字の混じった 32 字以上の続き。base64 の鍵や署名。_ を含む識別子と道の / では切る
  [/(?=[\dA-Za-z+=-]*\d)(?=[\dA-Za-z+=-]*[A-Za-z])[\dA-Za-z+=-]{32,}/g, "[伏せた]"],
];

/**
 * 外に出す文の、鍵、トークン、メール、ID (UUID、16 桁以上の 16 進数)、鍵らしい長い文字列を伏せる。GitHub の Issue に渡す前に通す
 * @param text 文
 * @returns 伏せた文
 */
export function redactPublic(text: string): string {
  return PUBLIC_TEXT.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), redactText(text));
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
