// API の返事に付けるセキュリティヘッダー。04-detail.md の 3.4 と API の決まりの 3.6 の 4
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "./env.ts";

/** 画面のファイルと同じ Content-Security-Policy。ルートが自分で付けた時はそちらを使う */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com";

const FIXED_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

/** 成功にも失敗にも同じヘッダーを付ける */
export const securityHeaders = createMiddleware<GateEnv>(async (c, next) => {
  await next();
  if (!c.res.headers.has("Content-Security-Policy")) c.res.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  for (const [name, value] of Object.entries(FIXED_HEADERS)) c.res.headers.set(name, value);
});
