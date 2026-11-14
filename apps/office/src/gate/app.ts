// ゲートウェイの Hono を作る。入力の検証に落ちた時の返し方と失敗の返し方をそろえる
import { OpenAPIHono, type Hook } from "@hono/zod-openapi";
import { AppError, type Clock, type FieldError, systemClock } from "@know-office/core";
import { HTTPException } from "hono/http-exception";
import type { ZodError } from "zod";
import { bodyShape } from "./body.ts";
import { securityHeaders } from "./headers.ts";
import type { GateEnv } from "./env.ts";
import { notFound, onError, problemResponse } from "./problem.ts";
import { trace } from "./trace.ts";

const TARGET_PREFIX: Record<string, string> = { json: "#", query: "#/query", param: "#/path", header: "#/header", cookie: "#/cookie" };

/**
 * Zod の失敗を項目ごとの JSON Pointer と理由に直す
 * @param error Zod の失敗
 * @param target 入力の置き場所 (json、query、param など)
 * @returns 項目ごとの理由
 */
export function toFieldErrors(error: ZodError, target: string): FieldError[] {
  const prefix = TARGET_PREFIX[target] ?? "#";
  return error.issues.map((issue) => ({
    pointer: [prefix, ...issue.path.map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1"))].join("/"),
    detail: issue.message,
  }));
}

/**
 * 入力の検証に落ちたら 422 validation_failed を投げる
 * @param result 検証の結果
 * @throws malformed_request クエリに知らないパラメーターがある時
 * @throws validation_failed 入力が Zod スキーマに合わない時
 */
export const defaultHook: Hook<unknown, GateEnv, string, unknown> = (result) => {
  if (result.success) return;
  // 知らないクエリパラメーターは入力の誤りでなく要求の誤りとして 400 にする。API の決まりの 3.1
  if (result.target === "query" && result.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
    throw new AppError("malformed_request", "未知のクエリパラメーターがある");
  }
  throw new AppError("validation_failed", "入力の検証に失敗した", { errors: toFieldErrors(result.error, result.target) });
};

/**
 * ルートのまとまりを書く Hono を作る。共通のミドルウェアは createApp の側にだけ付ける
 * @returns 入力の検証の返し方だけを持つ Hono
 */
export function createRouter() {
  return new OpenAPIHono<GateEnv>({ defaultHook });
}

/**
 * 共通のミドルウェアと失敗の返し方を付けた Hono を作る
 * @param options clock は今の時刻。テストは決まった時刻を渡す
 * @returns ルートを足す前のゲートウェイ
 */
export function createApp(options: { clock?: Clock } = {}) {
  const clock = options.clock ?? systemClock;
  const app = new OpenAPIHono<GateEnv>({ defaultHook });
  app.use("*", async (c, next) => {
    c.set("clock", clock);
    await next();
  });
  app.use("*", trace);
  app.use("/api/*", securityHeaders);
  app.use("/api/*", bodyShape);
  app.notFound((c) => {
    const allowed = allowedMethods(app, c.req.path);
    if (allowed.length > 0) {
      return problemResponse(c, new AppError("method_not_allowed", `${c.req.method} は使えない`, { headers: { Allow: allowed.join(", ") } }));
    }
    return notFound(c);
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 400) {
      return problemResponse(c, new AppError("malformed_request", "リクエストを解釈できない"));
    }
    return onError(err, c);
  });
  return app;
}

/**
 * パスに合うルートのメソッドを集める
 * @param app ゲートウェイ
 * @param path 要求のパス
 * @returns 使えるメソッド。ルートが無ければ空
 */
function allowedMethods(app: OpenAPIHono<GateEnv>, path: string): string[] {
  const methods = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const escaped = route.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*")}$`);
    if (pattern.test(path)) methods.add(route.method);
  }
  return [...methods].toSorted();
}
