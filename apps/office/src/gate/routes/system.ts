// システム: 稼働確認と API ドキュメント
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, Health, health } from "@know-office/core";
import v1 from "../../../openapi/v1.yaml?raw";
import { createRouter } from "../app.ts";
import { CONTENT_SECURITY_POLICY } from "../headers.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";

const getHealth = createRoute({
  method: "get",
  path: "/api/v1/health",
  operationId: "getHealth",
  tags: ["system"],
  responses: { 200: okResponse(Health), ...problems(401, 403, 429, 500, 503) },
});

const getApiDocs = createRoute({
  method: "get",
  path: "/api/v1/docs",
  operationId: "getApiDocs",
  tags: ["system"],
  responses: { 200: { description: "Swagger UI の HTML", content: { "text/html": { schema: z.string() } } }, ...problems(401, 403, 429, 500) },
});

const getOpenApi = createRoute({
  method: "get",
  path: "/api/v1/openapi.yaml",
  operationId: "getOpenApi",
  tags: ["system"],
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
    return ok(c, health("gate"));
  })
  .openapi(getApiDocs, (c) => {
    // Swagger UI は style 属性を使うので、このルートだけ style-src に unsafe-inline を足す。API の決まりの 3.5
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"));
    return c.html(DOCS_HTML, 200);
  })
  .openapi(getOpenApi, (c) => c.body(v1, 200, { "Content-Type": "application/yaml; charset=utf-8" }));
