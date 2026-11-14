// 要求ごとのトレース ID を決める。traceparent があればその trace-id を引き継ぐ
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "./env.ts";

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * 32 桁の 16 進数のトレース ID を作る
 * @returns 新しいトレース ID
 */
export function newTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** traceparent の trace-id か新しい ID を c.var.traceId に置く */
export const trace = createMiddleware<GateEnv>(async (c, next) => {
  const match = TRACEPARENT.exec(c.req.header("traceparent") ?? "");
  c.set("traceId", match?.[1] ?? newTraceId());
  await next();
});
