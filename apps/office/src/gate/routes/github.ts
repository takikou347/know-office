// GitHub 連携のうち、ルールを読み、変えるルート (ルートの一覧の 1.10、タスクとレビューの 3.4)
import { createRoute } from "@hono/zod-openapi";
import { GitHubRules, UpdateGitHubRulesInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { loadGitHubRules, protectRepos, RULES_KEY, updateGitHubRules } from "../github/rules.ts";
import { audit } from "../ledger/record.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";

const router = createRouter();

const getGitHubRulesRoute = createRoute({
  method: "get",
  path: "/api/v1/github/rules",
  operationId: "getGitHubRules",
  tags: ["github"],
  responses: { 200: okResponse(GitHubRules), ...problems(401, 403, 429, 500) },
});

const updateGitHubRulesRoute = createRoute({
  method: "put",
  path: "/api/v1/github/rules",
  operationId: "updateGitHubRules",
  tags: ["github"],
  "x-step-up": true,
  request: { body: { content: { "application/json": { schema: UpdateGitHubRulesInput } }, required: true } },
  responses: { 200: okResponse(GitHubRules), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500, 502) },
});

/** GitHub のルートのうちルール */
export const githubRoutes = router
  .openapi(getGitHubRulesRoute, async (c) => ok(c, await loadGitHubRules(c.env.DB)))
  .openapi(updateGitHubRulesRoute, async (c) => {
    // 触れるリポジトリを広げると守りが弱まるので、どの変更もパスキーで確かめる
    requireStepUp(c);
    const { repos, version, reason } = c.req.valid("json");
    const rules = await updateGitHubRules(c.env.DB, { repos, version, reason, now: c.var.clock.now() });
    await audit(c, "github.rules", RULES_KEY, { repos: rules.repos, version: rules.version, reason });
    // 変えたルールと記録を残してから掛け直す。GitHub が失敗してもゲートウェイの判断は新しいルールで守る
    await protectRepos(c.env, c.var.forge);
    return ok(c, rules);
  });
