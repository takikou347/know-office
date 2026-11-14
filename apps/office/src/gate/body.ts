// 本文の形の確かめ。application/json だけを 1MB まで受ける
import { AppError } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "./env.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/** 本文のある要求は Content-Type と大きさを確かめる。違えば 415 か 413 */
export const bodyShape = createMiddleware<GateEnv>(async (c, next) => {
  if (METHODS_WITH_BODY.has(c.req.method)) {
    const length = Number(c.req.header("Content-Length") ?? "0");
    if (length > MAX_BODY_BYTES) throw new AppError("payload_too_large", "リクエスト本文が 1MB を超える");
    const type = c.req.header("Content-Type") ?? "";
    const hasBody = length > 0 || c.req.raw.body !== null;
    if (hasBody && type.split(";")[0]?.trim() !== "application/json") {
      throw new AppError("unsupported_media_type", "Content-Type は application/json だけを受ける");
    }
    if (hasBody) {
      const text = await c.req.raw.clone().text();
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new AppError("payload_too_large", "リクエスト本文が 1MB を超える");
    }
  }
  await next();
});
