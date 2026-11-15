// GitHub 連携のルート。App を作って入れ、連携したリポジトリを読み、ルールを読み書きし、通知を受ける (ルートの一覧の 1.10、タスクとレビューの 3.2 から 3.5)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, GitHubCallbackQuery, GitHubInstallationRepos, GitHubInstalledQuery, GitHubManifest, GitHubRules, Repo, Secret, UpdateGitHubRulesInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { storeStatements } from "../auth/vault.ts";
import { endpoints } from "../endpoints.ts";
import { appManifest, callGitHub, checkInstallation, consumeState, exchangeCode, githubToken, loadLink, parseGitHub, signState } from "../github/app.ts";
import { receiveHook } from "../github/hooks.ts";
import { loadGitHubRules, protectRepos, RULES_KEY, updateGitHubRules } from "../github/rules.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, noContent, ok, redirect } from "../respond.ts";

const router = createRouter();

/** 一覧のカーソル。GitHub のページの番号 */
const PageCursor = z.string().regex(/^[1-9]\d{0,3}$/);

/** App もインストールも使える物が無い時だけ書く条件。インストールの前の App を別の code で置き換えない */
const NOT_LINKED = { sql: "NOT EXISTS (SELECT 1 FROM vault WHERE name IN ('github_app', 'github_installation') AND revoked_at IS NULL)", args: [] };

const connectGitHubRoute = createRoute({
  method: "post",
  path: "/api/v1/github/connect",
  operationId: "connectGitHub",
  tags: ["github"],
  "x-step-up": true,
  // 外部連携を始めるのでパスキーで確かめる
  middleware: [stepUpGate] as const,
  responses: { 200: okResponse(GitHubManifest), ...problems(401, 403, 409, 429, 500) },
});

const redirectResponse = (description: string) => ({ description, headers: { Location: { schema: { type: "string" as const } } } });

const receiveGitHubAppRoute = createRoute({
  method: "get",
  path: "/api/v1/github/callback",
  operationId: "receiveGitHubApp",
  tags: ["github"],
  request: { query: GitHubCallbackQuery },
  responses: { 302: redirectResponse("GitHub App のインストール画面にリダイレクトする"), ...problems(400, 401, 403, 409, 422, 429, 500, 502) },
});

const receiveGitHubInstallRoute = createRoute({
  method: "get",
  path: "/api/v1/github/installed",
  operationId: "receiveGitHubInstall",
  tags: ["github"],
  request: { query: GitHubInstalledQuery },
  responses: { 302: redirectResponse("設定画面にリダイレクトする"), ...problems(400, 401, 403, 409, 422, 429, 500, 502) },
});

const listGitHubReposRoute = createRoute({
  method: "get",
  path: "/api/v1/github/repos",
  operationId: "listGitHubRepos",
  tags: ["github"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(Repo), ...problems(400, 401, 403, 422, 429, 500, 502) },
});

const receiveGitHubWebhookRoute = createRoute({
  method: "post",
  path: "/hooks/v1/github",
  operationId: "receiveGitHubWebhook",
  tags: ["github"],
  security: [],
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 413, 429, 500) },
});

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
  // 触れるリポジトリを広げると守りが弱まるので、どの変更もパスキーで確かめる
  middleware: [stepUpGate] as const,
  request: { body: { content: { "application/json": { schema: UpdateGitHubRulesInput } }, required: true } },
  responses: { 200: okResponse(GitHubRules), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500, 502) },
});

/** GitHub のルート。連携、リポジトリ、ルール */
export const githubRoutes = router
  .openapi(connectGitHubRoute, async (c) => {
    const link = await loadLink(c.env);
    if (link.installation) throw new AppError("conflict", "すでに連携済み");
    // 作った App を入れないまま離れた時は、作り直さずにその App のインストール先へ戻す
    if (link.app) return ok(c, { action: `${endpoints(c.env).githubWeb}/apps/${link.app.slug}/installations/new`, manifest: null, state: null });
    const state = await signState(c.env, c.var.clock);
    return ok(c, { action: `${endpoints(c.env).githubWeb}/settings/apps/new?state=${state}`, manifest: appManifest(new URL(c.req.url).origin), state });
  })
  .openapi(receiveGitHubAppRoute, async (c) => {
    const { code, state } = c.req.valid("query");
    await consumeState(c.env, c.var.clock, state);
    const link = await loadLink(c.env);
    if (link.installation) throw new AppError("conflict", "すでに連携済み");
    if (link.app) throw new AppError("conflict", "作った App をまだインストールしていない");
    const made = await exchangeCode(c.env, c.var.fetch, code);
    const keys = new Secret(JSON.stringify({ appId: made.id, slug: made.slug, privateKey: made.pem, webhookSecret: made.webhook_secret }));
    const now = c.var.clock.now();
    // 読んだ版から書く 1 文で、同時に戻った 2 つの片方だけを置く
    const statements = await storeStatements(c.env.DB, { name: "github_app", value: keys, top: link.appTop, now, master: c.env.MASTER_KEY, when: NOT_LINKED });
    const [written] = await c.env.DB.batch(statements);
    if ((written?.meta.changes ?? 0) === 0) throw new AppError("conflict", "同じ時に別の App を置いた");
    await audit(c, "github.app_created", String(made.id), { slug: made.slug });
    return redirect(c, `${endpoints(c.env).githubWeb}/apps/${made.slug}/installations/new`);
  })
  .openapi(receiveGitHubInstallRoute, async (c) => {
    const { installation_id: installationId } = c.req.valid("query");
    const link = await loadLink(c.env);
    if (!link.app) throw new AppError("forbidden", "自分の App のインストールではない");
    await checkInstallation(c.env, c.var.fetch, link.app, installationId, c.var.clock.now());
    // 設定を変えて戻った時と、同じ戻りが 2 度来た時は書かない
    if (link.installation?.id === installationId) return redirect(c, "/settings");
    const now = c.var.clock.now();
    const statements = await storeStatements(c.env.DB, {
      name: "github_installation",
      value: new Secret(JSON.stringify({ id: installationId })),
      top: link.installationTop,
      now,
      master: c.env.MASTER_KEY,
      when: { sql: "EXISTS (SELECT 1 FROM vault WHERE name = 'github_app' AND version = ? AND revoked_at IS NULL)", args: [link.app.version] },
    });
    const [written] = await c.env.DB.batch(statements);
    if ((written?.meta.changes ?? 0) === 0) {
      if ((await loadLink(c.env)).installation?.id === installationId) return redirect(c, "/settings");
      throw new AppError("conflict", "同じ時に連携が変わった");
    }
    await audit(c, "github.installed", String(installationId), { appId: link.app.appId });
    return redirect(c, "/settings");
  })
  .openapi(listGitHubReposRoute, async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const parsed = PageCursor.safeParse(cursor ?? "1");
    if (!parsed.success) throw new AppError("validation_failed", "cursor の形が違う", { errors: [{ pointer: "#/query/cursor", detail: "前の返事の meta.next を送る" }] });
    const page = Number(parsed.data);
    const token = await githubToken(c.env, c.var.github, null, { metadata: "read" });
    const res = await callGitHub(c.env, c.var.fetch, `installation/repositories?per_page=${String(limit)}&page=${String(page)}`, { headers: { authorization: `Bearer ${token.reveal()}` } });
    if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
    const found = await parseGitHub(res, GitHubInstallationRepos);
    const next = page * limit < found.total_count ? String(page + 1) : null;
    return list(
      c,
      found.repositories.map((r) => ({ fullName: r.full_name, private: r.private })),
      next,
    );
  })
  .openapi(getGitHubRulesRoute, async (c) => ok(c, await loadGitHubRules(c.env.DB)))
  .openapi(updateGitHubRulesRoute, async (c) => {
    const { repos, version, reason } = c.req.valid("json");
    const rules = await updateGitHubRules(c.env.DB, { repos, version, reason, now: c.var.clock.now() });
    await audit(c, "github.rules", RULES_KEY, { repos: rules.repos, version: rules.version, reason });
    // 変えたルールと記録を残してから掛け直す。GitHub が失敗してもゲートウェイの判断は新しいルールで守る
    await protectRepos(c.env, c.var.forge);
    return ok(c, rules);
  });

/** GitHub の通知のルート。Access とログインセッションの外に置き、署名で確かめる */
export const hookRoutes = createRouter().openapi(receiveGitHubWebhookRoute, async (c) => {
  await receiveHook(c);
  return noContent(c);
});
