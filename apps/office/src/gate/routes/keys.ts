// 自動停止: 全体を止めた後に入れ直す鍵を読み、GitHub App の鍵と Claude の API の鍵を入れ直す (ルートの一覧の 1.5、自動停止の 3.5)
import { createRoute } from "@hono/zod-openapi";
import { GuardKeys, ReplaceClaudeKeyInput, ReplaceGitHubAppKeyInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { guardKeys, replaceClaudeKey, replaceGitHubAppKey } from "../guard/keys.ts";
import { audit } from "../ledger/record.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });

const getKeysRoute = createRoute({
  method: "get",
  path: "/api/v1/guard/keys",
  operationId: "getGuardKeys",
  tags: ["guard"],
  responses: { 200: okResponse(GuardKeys), ...problems(401, 403, 429, 500) },
});

const replaceGitHubAppKeyRoute = createRoute({
  method: "put",
  path: "/api/v1/guard/keys/github-app",
  operationId: "replaceGitHubAppKey",
  tags: ["guard"],
  "x-step-up": true,
  // 入れ直すと全体を再開できるようになるので、入力を確かめる前にパスキーで確かめる
  middleware: [stepUpGate] as const,
  request: { body: jsonBody(ReplaceGitHubAppKeyInput) },
  responses: { 200: okResponse(GuardKeys), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500, 502) },
});

const replaceClaudeKeyRoute = createRoute({
  method: "put",
  path: "/api/v1/guard/keys/claude",
  operationId: "replaceClaudeKey",
  tags: ["guard"],
  "x-step-up": true,
  middleware: [stepUpGate] as const,
  request: { body: jsonBody(ReplaceClaudeKeyInput) },
  responses: { 200: okResponse(GuardKeys), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500) },
});

/** 全体を止めた後の鍵のルート */
export const guardKeyRoutes = createRouter()
  .openapi(getKeysRoute, async (c) => ok(c, await guardKeys(c.env)))
  .openapi(replaceGitHubAppKeyRoute, async (c) => {
    const keys = await replaceGitHubAppKey(c.env, c.var.fetch, c.req.valid("json"), c.var.clock.now());
    await audit(c, "guard.keys_replaced", "github_app", { kind: "github_app", pending: keys.pending });
    return ok(c, keys);
  })
  .openapi(replaceClaudeKeyRoute, async (c) => {
    const keys = await replaceClaudeKey(c.env, c.req.valid("json").apiKey, c.var.clock.now());
    await audit(c, "guard.keys_replaced", "claude", { kind: "claude", pending: keys.pending });
    return ok(c, keys);
  });
