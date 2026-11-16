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
  summary: "全体を止めた後に入れ直す鍵",
  "x-steps": ["`GuardDO.keyState` で、全体を止めた後に入れ直す鍵の印と、まだ入れ直していない鍵を読む"],
  responses: { 200: okResponse(GuardKeys), ...problems(401, 403, 429, 500) },
});

const replaceGitHubAppKeyRoute = createRoute({
  method: "put",
  path: "/api/v1/guard/keys/github-app",
  operationId: "replaceGitHubAppKey",
  tags: ["guard"],
  summary: "GitHub App の鍵を入れ直す",
  description: "15 分以内のパスキーの確認が必要。全体を止めた後、止める前の連携の App で作り直した秘密鍵と通知の秘密を入れる。連携をやり直す時は `POST /api/v1/github/connect` から入れ直す。",
  "x-steps": [
    "パスキーの確認を求め、全体が止まっていることを確認する",
    "`vault` の `github_app` と `github_installation` の最後の版から、止める前の連携の App ID とインストール ID を読む",
    "新しい秘密鍵で作った App の JWT で、そのインストールが同じ App のものかを GitHub に問い合わせる",
    "読んだ時から `github_app` と `github_installation` の版が進んでおらず、まだ使える連携が無い時だけ、新しい秘密鍵と通知の秘密とインストールを 1 回のバッチで暗号化して `vault` に保存する",
    "`GuardDO.releaseKeys` で GitHub App の鍵の印を外し、監査ログに `guard.keys_replaced` を記録する",
  ],
  "x-errors": [
    "409 `conflict`: 全体が止まっていない、止める前の連携が無い、インストールが外れている、または同じ時に別の鍵を保存した",
    "422 `validation_failed`: 秘密鍵の形が違う、または秘密鍵が App と合わない",
    "502 `upstream_failed`: GitHub がエラーを返した",
  ],
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
  summary: "Claude の API の鍵を入れ直す",
  description: "15 分以内のパスキーの確認が必要。全体を止めた後、Anthropic の画面で作り直した鍵を入れる。入れた後は環境変数の `ANTHROPIC_API_KEY` を使わない。",
  "x-steps": [
    "パスキーの確認を求め、全体が止まっていることを確認する",
    "読んだ時から `claude_api_key` の版が進んでいない時だけ、新しい鍵を暗号化して `vault` に保存し、前の版を取り消す",
    "`GuardDO.releaseKeys` で Claude の鍵の印を外し、監査ログに `guard.keys_replaced` を記録する",
  ],
  "x-errors": ["409 `conflict`: 全体が止まっていない、または同じ時に別の鍵を保存した"],
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
