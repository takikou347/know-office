// 失敗の返し方。RFC 9457 の problem+json に直す
import { AppError, type ErrorCode, type FieldError, log, PROBLEMS, type Problem, systemClock } from "@know-office/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { GateEnv } from "./env.ts";
import { GitHubRateLimited, noteGitHubRateLimit } from "./github/limits.ts";
import { recordError } from "./ledger/errors.ts";
import { audit } from "./ledger/record.ts";

/**
 * problem+json の本文を作る
 * @param c 要求の文脈
 * @param code 失敗の種類
 * @param detail その時の中身
 * @param errors 422 の項目ごとの理由
 * @returns problem+json の本文
 */
export function problemBody(c: Context<GateEnv>, code: ErrorCode, detail: string, errors?: FieldError[]): Problem {
  const { status, title } = PROBLEMS[code];
  const body: Problem = {
    type: `urn:know-office:problem:${code}`,
    title,
    status,
    detail,
    instance: c.req.path,
    code,
    traceId: c.var.traceId,
  };
  if (errors) body.errors = errors;
  return body;
}

/**
 * problem+json の応答を作る
 * @param c 要求の文脈
 * @param err 想定した失敗
 * @returns problem+json の応答
 */
export function problemResponse(c: Context<GateEnv>, err: AppError): Response {
  const body = problemBody(c, err.code, err.message, err.errors);
  const headers = new Headers({ "Content-Type": "application/problem+json", ...err.headers });
  return new Response(JSON.stringify(body), { status: body.status, headers });
}

/**
 * 投げられた失敗を problem+json に直す。想定外は 500 で中身を返さない
 * @param err 投げられた物
 * @param c 要求の文脈
 * @returns problem+json の返事
 */
export const onError: ErrorHandler<GateEnv> = async (err, c) => {
  const known = err instanceof AppError ? err : new AppError("internal", "想定外のエラーが起きた");
  const status = PROBLEMS[known.code].status;
  // 500 台は直す所なので、スタックトレースを log に、1 行を error_events に残す。中身は返事に入れない
  if (status >= 500) {
    const traceId = c.get("traceId");
    log("error", "request_failed", { traceId, route: c.req.routePath, status, code: known.code, stack: err instanceof Error ? err.stack : undefined });
    await recordError(c.env, { source: "gate", level: "error", code: known.code, error: err, route: c.req.routePath, status, traceId }, c.get("clock") ?? systemClock);
  }
  if (known.code === "step_up_required") await recordDenied(c);
  // ゲートウェイが GitHub を呼んで当たったレート制限は、社員のツールでもオーナーの操作でも通知に出す
  if (err instanceof GitHubRateLimited) {
    await noteGitHubRateLimit(c.env, c.get("clock") ?? systemClock, { seconds: err.seconds, route: c.req.routePath, status, traceId: c.get("traceId") });
  }
  return problemResponse(c, known);
};

/**
 * パスキーの確認が無くて断った操作を監査ログに残す。ルート、メソッド、パスの値、ログインセッションだけを残し、本文は入れない。
 * ログインセッションの無い要求は残さない。監査ログに書けなくても断る返事は変えず、エラーログに残す
 * @param c 要求の文脈
 */
async function recordDenied(c: Context<GateEnv>): Promise<void> {
  const session = c.get("session");
  if (!session) return;
  const params: Record<string, string> = c.req.param();
  try {
    await audit(c, "step_up.denied", Object.values(params)[0] ?? null, { method: c.req.method, route: c.req.routePath, params, sessionId: session.id });
  } catch (error) {
    await recordError(c.env, { source: "gate", level: "warn", code: "step_up_denied_audit_failed", error, route: c.req.routePath, traceId: c.get("traceId") }, c.get("clock") ?? systemClock);
  }
}

/**
 * 無いルートは 404 の problem+json
 * @param c 要求の文脈
 * @returns problem+json の返事
 */
export const notFound: NotFoundHandler<GateEnv> = (c) => problemResponse(c, new AppError("not_found", `${c.req.path} は存在しない`));
