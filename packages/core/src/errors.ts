// API の失敗の種類。ステータスと短い題を code ごとに決め、画面は code で分ける
// 正本は knowidea の services/know-office/docs/04-detail/1-api.md の 3.1

export const ERROR_CODES = [
  "malformed_request",
  "unauthenticated",
  "step_up_required",
  "forbidden",
  "locked_out",
  "origin_mismatch",
  "rule_denied",
  "not_found",
  "method_not_allowed",
  "conflict",
  "stopped",
  "payload_too_large",
  "unsupported_media_type",
  "validation_failed",
  "rate_limited",
  "internal",
  "upstream_failed",
  "unavailable",
  "upstream_timeout",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** code ごとのステータスと題 */
export const PROBLEMS: Record<ErrorCode, { status: number; title: string }> = {
  malformed_request: { status: 400, title: "リクエストを解釈できない" },
  unauthenticated: { status: 401, title: "認証されていない" },
  step_up_required: { status: 401, title: "パスキーの確認が必要" },
  forbidden: { status: 403, title: "許可されていない" },
  locked_out: { status: 403, title: "ロックアウト中" },
  origin_mismatch: { status: 403, title: "Origin が異なる" },
  rule_denied: { status: 403, title: "ルールで禁止された操作" },
  not_found: { status: 404, title: "存在しない" },
  method_not_allowed: { status: 405, title: "メソッドが異なる" },
  conflict: { status: 409, title: "現在の状態と競合する" },
  stopped: { status: 409, title: "停止中" },
  payload_too_large: { status: 413, title: "リクエスト本文が大きすぎる" },
  unsupported_media_type: { status: 415, title: "Content-Type が application/json ではない" },
  validation_failed: { status: 422, title: "入力の検証に失敗した" },
  rate_limited: { status: 429, title: "レート制限を超えた" },
  internal: { status: 500, title: "想定外のエラー" },
  upstream_failed: { status: 502, title: "外部のサービスがエラーを返した" },
  unavailable: { status: 503, title: "一時的に利用できない" },
  upstream_timeout: { status: 504, title: "外部のサービスが応答しない" },
};

/** 422 の項目ごとの理由。pointer は JSON Pointer で、クエリは #/query/<名前> */
export type FieldError = { pointer: string; detail: string };

/** 想定した失敗。ゲートウェイの最後の受け手が problem+json に直す */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string>;

  /**
   * @param code 失敗の種類
   * @param detail その時の中身。500 では画面に出さない
   * @param options 422 の項目ごとの理由と、足すヘッダー
   * @param options.errors 422 の項目ごとの理由
   * @param options.headers 足すヘッダー (Allow、Retry-After など)
   */
  constructor(code: ErrorCode, detail: string, options: { errors?: FieldError[]; headers?: Record<string, string> } = {}) {
    super(detail);
    this.name = "AppError";
    this.code = code;
    this.errors = options.errors;
    this.headers = options.headers ?? {};
  }
}
