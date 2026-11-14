// 失敗の返し方。RFC 9457 の problem+json に直す
import { AppError, type ErrorCode, type FieldError, PROBLEMS, type Problem } from "@know-office/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { GateEnv } from "./env.ts";

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
export const onError: ErrorHandler<GateEnv> = (err, c) => {
  if (err instanceof AppError) return problemResponse(c, err);
  return problemResponse(c, new AppError("internal", "想定外のエラーが起きた"));
};

/**
 * 無いルートは 404 の problem+json
 * @param c 要求の文脈
 * @returns problem+json の返事
 */
export const notFound: NotFoundHandler<GateEnv> = (c) => problemResponse(c, new AppError("not_found", `${c.req.path} は存在しない`));
