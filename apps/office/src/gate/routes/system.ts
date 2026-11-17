// システム: 稼働確認と API ドキュメント
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, Health, health } from "@know-office/core";
import v1 from "../../../openapi/v1.yaml?raw";
import { createRouter } from "../app.ts";
import { CONTENT_SECURITY_POLICY } from "../headers.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { checkEnv } from "../config.ts";

const getHealth = createRoute({
  method: "get",
  path: "/api/v1/health",
  operationId: "getHealth",
  tags: ["system"],
  summary: "ゲートウェイの稼働確認",
  description: "D1 が止まっても答えるよう、ログインセッションの検証を通らない。デプロイの後の確かめのため、Access の証明はオーナーのほかに、`ACCESS_SMOKE_CLIENT_ID` の作業用の鍵の証明もこのルートだけ通す。",
  "x-steps": [
    "`DB` に `SELECT 1` を実行する",
    "設定 (環境変数、秘密、バインディング) を 1 つの形で確かめ、足りない項目と形の違う項目の名前だけを `missing` に並べる。値は返さない",
    "応答した部分 (ゲートウェイ、画面、ワークスペース) を返す。`missing` が空でなければ `ok` は `false`",
  ],
  "x-errors": ["503 `unavailable`: D1 が応答しない"],
  security: [{ accessJwt: [] }],
  responses: { 200: okResponse(Health), ...problems(401, 403, 429, 500, 503) },
});

const getApiDocs = createRoute({
  method: "get",
  path: "/api/v1/docs",
  operationId: "getApiDocs",
  tags: ["system"],
  summary: "Swagger UI",
  "x-steps": ["静的ファイルから Swagger UI の HTML を返す"],
  responses: { 200: { description: "Swagger UI の HTML", content: { "text/html": { schema: z.string() } } }, ...problems(401, 403, 429, 500) },
});

const getOpenApi = createRoute({
  method: "get",
  path: "/api/v1/openapi.yaml",
  operationId: "getOpenApi",
  tags: ["system"],
  summary: "この OpenAPI ドキュメント",
  "x-steps": ["静的ファイルから `v1.yaml` を返す"],
  responses: { 200: { description: "OpenAPI 3.1 のドキュメント", content: { "application/yaml": { schema: z.string() } } }, ...problems(401, 403, 429, 500) },
});

const DOCS_HTML = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>know-office API</title><link rel="stylesheet" href="/swagger/swagger-ui.css"></head>
<body><div id="swagger"></div><script src="/swagger/swagger-ui-bundle.js"></script><script src="/swagger/swagger-init.js"></script></body>
</html>`;

/** システムのルート: 稼働確認、Swagger UI、OpenAPI の文書 */
export const system = createRouter()
  .openapi(getHealth, async (c) => {
    try {
      await c.env.DB.prepare("SELECT 1").first();
    } catch {
      throw new AppError("unavailable", "D1 が応答しない");
    }
    const missing = checkEnv(c.env);
    return ok(c, { ...health("gate"), ok: missing.length === 0, missing });
  })
  .openapi(getApiDocs, (c) => {
    // Swagger UI は style 属性を使うので、このルートだけ style-src に unsafe-inline を足す。API の決まりの 4.1
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"));
    return c.html(DOCS_HTML, 200);
  })
  .openapi(getOpenApi, (c) => c.body(v1, 200, { "Content-Type": "application/yaml; charset=utf-8" }));
