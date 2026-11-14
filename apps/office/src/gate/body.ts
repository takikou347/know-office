// 本文の形の確かめ。application/json だけを 1MB まで受ける
import { AppError } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "./env.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/**
 * 本文を読みながら大きさを数え、上限を超えたら読むのを止める
 * @param body 本文のストリーム
 * @param limit 上限のバイト数
 * @returns 上限を超えたら true
 */
async function exceeds(body: ReadableStream<Uint8Array>, limit: number): Promise<boolean> {
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    total += value.byteLength;
    if (total > limit) {
      // tee の片方の cancel は両方が止まるまで終わらないので待たない
      void reader.cancel();
      return true;
    }
  }
}

/**
 * 本文のある要求は Content-Type と大きさを確かめる
 * @throws payload_too_large Content-Length か読んだ本文が 1MB を超える時
 * @throws unsupported_media_type 本文があり Content-Type が application/json でない時
 */
export const bodyShape = createMiddleware<GateEnv>(async (c, next) => {
  if (METHODS_WITH_BODY.has(c.req.method)) {
    const length = Number(c.req.header("Content-Length") ?? "0");
    // Content-Length が超えていれば読む前に断る。API の決まりの 1.2 の 7
    if (length > MAX_BODY_BYTES) throw new AppError("payload_too_large", "リクエスト本文が 1MB を超える");
    const body = c.req.raw.clone().body;
    if (body) {
      const type = c.req.header("Content-Type") ?? "";
      if (type.split(";")[0]?.trim() !== "application/json") {
        void body.cancel();
        throw new AppError("unsupported_media_type", "Content-Type は application/json だけを受ける");
      }
      if (await exceeds(body, MAX_BODY_BYTES)) throw new AppError("payload_too_large", "リクエスト本文が 1MB を超える");
    }
  }
  await next();
});
