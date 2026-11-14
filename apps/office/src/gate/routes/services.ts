// サービス: アイデアから運用まで。案を足し、一覧と詳細を読み、オーナーが段階を移す (ルートの一覧の 1.11、サービスと拡張の 3.1)
import { createRoute, z } from "@hono/zod-openapi";
import { AdvanceInput, CreateIdeaInput, ServiceCard, ServiceDetail, ServiceStage } from "@know-office/core";
import { createRouter } from "../app.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, ok } from "../respond.ts";
import { advanceService, createIdea, listServices, loadService, toCard } from "../services/flow.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ServiceParam = z.object({ serviceId: z.uuid().openapi({ param: { name: "serviceId", in: "path" }, description: "UUID v7" }) }).strict();

const listServicesRoute = createRoute({
  method: "get",
  path: "/api/v1/services",
  operationId: "listServices",
  tags: ["services"],
  request: { query: listQuery(router).extend({ stage: ServiceStage.optional().openapi({ param: { name: "stage", in: "query" } }) }) },
  responses: { 200: listResponse(ServiceCard), ...problems(400, 401, 403, 422, 429, 500) },
});

const createIdeaRoute = createRoute({
  method: "post",
  path: "/api/v1/services",
  operationId: "createIdea",
  tags: ["services"],
  request: { body: jsonBody(CreateIdeaInput) },
  responses: {
    201: { ...okResponse(ServiceCard, "作成した"), headers: { Location: { description: "作成したリソースの URL", schema: { type: "string" } } } },
    ...problems(400, 401, 403, 413, 415, 422, 429, 500),
  },
});

const getServiceRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{serviceId}",
  operationId: "getService",
  tags: ["services"],
  request: { params: ServiceParam },
  responses: { 200: okResponse(ServiceDetail), ...problems(401, 403, 404, 429, 500) },
});

const advanceServiceRoute = createRoute({
  method: "post",
  path: "/api/v1/services/{serviceId}/advance",
  operationId: "advanceService",
  tags: ["services"],
  request: { params: ServiceParam, body: jsonBody(AdvanceInput) },
  responses: { 200: okResponse(ServiceCard), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500) },
});

/** サービスのルート */
export const serviceRoutes = router
  .openapi(listServicesRoute, async (c) => {
    const { items, next } = await listServices(c.env.DB, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(createIdeaRoute, async (c) => {
    const row = await createIdea(c.env, c.req.valid("json"), { by: "owner", now: c.var.clock.now(), traceId: c.var.traceId });
    await audit(c, "service.create", row.id, { name: row.name, kind: row.kind });
    return created(c, toCard(row), `/api/v1/services/${row.id}`);
  })
  .openapi(getServiceRoute, async (c) => {
    return ok(c, await loadService(c.env, c.req.valid("param").serviceId, c.var.clock.now()));
  })
  .openapi(advanceServiceRoute, async (c) => {
    const { serviceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const row = await advanceService(c.env, serviceId, input, { by: "owner", now: c.var.clock.now(), traceId: c.var.traceId });
    await audit(c, "service.advance", serviceId, { to: input.to, reason: input.reason });
    return ok(c, toCard(row));
  });
