// 開発の回し方: 設計書のリポジトリを読み、選ぶ (API の devloop、開発の回し方の 3.2)
import { createRoute } from "@hono/zod-openapi";
import { DOCS_REPO_KEY, DocsRepo, UpdateDocsRepoInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { setDocsRepo } from "../devloop/docs-repo.ts";
import { loadDocsRepo } from "../devloop/docs-setting.ts";
import { audit } from "../ledger/record.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";

const getDocsRepoRoute = createRoute({
  method: "get",
  path: "/api/v1/devloop/docs-repo",
  operationId: "getDocsRepo",
  tags: ["devloop"],
  summary: "設計書のリポジトリ",
  "x-steps": ["`settings` から `devloop.docs_repo` の最新の値を取得する。まだ選んでいなければ `repo` は `null`、`version` は 0"],
  responses: { 200: okResponse(DocsRepo), ...problems(401, 403, 429, 500) },
});

const updateDocsRepoRoute = createRoute({
  method: "put",
  path: "/api/v1/devloop/docs-repo",
  operationId: "updateDocsRepo",
  tags: ["devloop"],
  summary: "設計書のリポジトリを選ぶ",
  description: "15 分以内のパスキーの確認が必要。試作に進めた案の設計書は、ここで選んだ非公開のリポジトリの `services/<名前>/` に置く。設計書のリポジトリの main に入れる条件は設定で弱められない。",
  "x-steps": [
    "パスキーの確認を求める",
    "GitHub と連携していて、GitHub App で触れるリポジトリの中にあり、非公開で、サービスのリポジトリでない事を確かめる",
    "`version` が現在と一致し、確かめた時の連携とサービスのリポジトリのままの時だけ、`settings` に `devloop.docs_repo` を追加する",
    "監査ログに `devloop.docs_repo` を記録する",
  ],
  "x-errors": [
    "409 `conflict`: GitHub と連携していない、バージョンが異なる、または確かめた後に連携かサービスのリポジトリが変わった",
    "422 `validation_failed`: 触れるリポジトリに無い (GitHub のルールの触れるリポジトリを含む)、公開のリポジトリ、またはサービスのリポジトリ",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した",
  ],
  "x-step-up": true,
  // 設計書のリポジトリを替えると守る先が替わるので、パスキーで確かめる
  middleware: [stepUpGate] as const,
  request: { body: { content: { "application/json": { schema: UpdateDocsRepoInput } }, required: true } },
  responses: { 200: okResponse(DocsRepo), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500, 502) },
});

/** 開発の回し方のルート */
export const devloopRoutes = createRouter()
  .openapi(getDocsRepoRoute, async (c) => {
    const docs = await loadDocsRepo(c.env.DB);
    return ok(c, docs ?? { repo: null, version: 0 });
  })
  .openapi(updateDocsRepoRoute, async (c) => {
    const { repo, version, reason } = c.req.valid("json");
    const docs = await setDocsRepo(c.env, c.var.github, { repo, version, reason, now: c.var.clock.now() });
    await audit(c, "devloop.docs_repo", DOCS_REPO_KEY, { repo: docs.repo, version: docs.version, reason });
    return ok(c, docs);
  });
