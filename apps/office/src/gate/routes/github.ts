// GitHub 連携のルート。App を作って入れ、連携したリポジトリを読み、ルールを読み書きし、通知を受ける (API の github、GitHub の連携の 3.1 から 3.4)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, GitHubCallbackQuery, GitHubInstalledQuery, GitHubLink, GitHubManifest, GitHubRules, GitHubRulesApplied, newId, Repo, Secret, UpdateGitHubRulesInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { storeStatements } from "../auth/vault.ts";
import { endpoints } from "../endpoints.ts";
import { appExists, appManifest, checkInstallation, consumeState, DROP_GONE_APP, exchangeCode, loadLink, NOT_LINKED, signState } from "../github/app.ts";
import { guardDo } from "../guard/actions.ts";
import { receiveHook } from "../github/hooks.ts";
import { installationRepos } from "../github/repos.ts";
import { choosableRepos } from "../services/repo.ts";
import { claimLock, releaseLock } from "../db/locks.ts";
import { loadGitHubRules, protectRepos, RULES_KEY, updateGitHubRules } from "../github/rules.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, noContent, ok, redirect } from "../respond.ts";

const router = createRouter();

/** 一覧のカーソル。GitHub のページの番号 */
const PageCursor = z.string().regex(/^[1-9]\d{0,3}$/);

const connectGitHubRoute = createRoute({
  method: "post",
  path: "/api/v1/github/connect",
  operationId: "connectGitHub",
  tags: ["github"],
  summary: "GitHub App の作成情報か、作ったまま入れていない App のインストール先を返す。パスキーの確認が必要",
  description: "15 分以内のパスキーの確認が必要。画面は `manifest` があれば `action` へ送信し、`null` なら `action` へ移る。",
  "x-steps": [
    "パスキーの確認を求め、まだ連携していない (`vault` にまだ使えるインストールが無い) ことを確認する",
    "作ったまま入れていない App があれば、App の JWT で GitHub の `GET /app` を呼ぶ。404 なら GitHub で消された App として、読んだ版がまだ使えてインストールが無い時だけ 1 文で `github_app` を取り消し、取り消せたら監査ログに `github.app_gone` を残して 3 へ進む。あれば作り直さず、その App のインストール先を `action` に入れ、`manifest` と `state` を `null` にして返す",
    "使い捨ての値を `github_states` に置き、ログインセッションの署名鍵で、その値を入れた 10 分間有効な `state` を生成する",
    "GitHub App の manifest と GitHub の URL を返す",
  ],
  "x-errors": ["409 `conflict`: すでに連携済み", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: `GET /app` が 404 のほかの失敗を返した"],
  "x-step-up": true,
  // 外部連携を始めるのでパスキーで確かめる
  middleware: [stepUpGate] as const,
  responses: { 200: okResponse(GitHubManifest), ...problems(401, 403, 409, 429, 500, 502) },
});

const redirectResponse = (description: string) => ({ description, headers: { Location: { schema: { type: "string" as const } } } });

const receiveGitHubAppRoute = createRoute({
  method: "get",
  path: "/api/v1/github/callback",
  operationId: "receiveGitHubApp",
  tags: ["github"],
  summary: "GitHub App の鍵を受け取る",
  description: "GitHub の画面から戻る所。ログインセッションのクッキーは SameSite=Strict で github.com から戻る時には付かないので、Access の証明と `state` で確かめ、ログインセッションは見ない。",
  "x-steps": [
    "`state` の署名と有効期限を検証し、`github_states` から使い捨ての値を 1 文で消す。消せなければ断る",
    "まだ連携していない、インストールの前の App も無いことを確認する",
    "`code` を App の鍵に交換し、暗号化して `vault` に保存する。読んだ時から `github_app` の版が進んだか、使える App かインストールがあれば保存しない",
    "監査ログに `github.app_created` を記録する",
    "302 で App のインストール画面にリダイレクトする",
  ],
  "x-errors": [
    "403 `forbidden`: `state` が一致しない、期限を過ぎた、またはもう使った",
    "409 `conflict`: すでに連携済み、インストールの前の App がある、または同じ時に別の App を保存した",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した",
  ],
  security: [{ accessJwt: [] }],
  request: { query: GitHubCallbackQuery },
  responses: { 302: redirectResponse("GitHub App のインストール画面にリダイレクトする"), ...problems(400, 401, 403, 409, 422, 429, 500, 502) },
});

const receiveGitHubInstallRoute = createRoute({
  method: "get",
  path: "/api/v1/github/installed",
  operationId: "receiveGitHubInstall",
  tags: ["github"],
  summary: "GitHub App のインストールを記録する",
  description: "クエリパラメーター名は GitHub の仕様のまま。GitHub の画面から戻る所なので、ログインセッションは見ない。",
  "x-steps": [
    "`installation_id` が自分の App のものかを GitHub に問い合わせる",
    "同じインストールがすでに記録されていれば、書かずに 302 で設定画面にリダイレクトする",
    "読んだ時の App の版がまだ使える時だけ `vault` に保存し、監査ログに `github.installed` を記録する。全体を止めた後なら `GuardDO.releaseKeys` で GitHub App の鍵の印を外す",
    "302 で設定画面にリダイレクトする",
  ],
  "x-errors": [
    "403 `forbidden`: 自分の App のインストールではない、または App を作っていない",
    "409 `conflict`: 同じ時に連携が変わった",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した",
  ],
  security: [{ accessJwt: [] }],
  request: { query: GitHubInstalledQuery },
  responses: { 302: redirectResponse("設定画面にリダイレクトする"), ...problems(400, 401, 403, 409, 422, 429, 500, 502) },
});

const getGitHubLinkRoute = createRoute({
  method: "get",
  path: "/api/v1/github/link",
  operationId: "getGitHubLink",
  tags: ["github"],
  summary: "GitHub と連携した今",
  description: "設定の画面の GitHub のカードが、未連携、App を作ってインストールする前、連携済みを分けるのに読む。鍵は返さない。",
  "x-steps": [
    "`vault` から GitHub App とインストールのまだ使える行を読む",
    "インストールがあれば `installed`、App だけあれば `app_created`、どちらも無ければ `none` を返す",
  ],
  responses: { 200: okResponse(GitHubLink), ...problems(401, 403, 429, 500) },
});

const listGitHubReposRoute = createRoute({
  method: "get",
  path: "/api/v1/github/repos",
  operationId: "listGitHubRepos",
  tags: ["github"],
  summary: "連携したリポジトリ",
  "x-steps": [
    "インストールで選んだすべてのリポジトリに届く、メタデータを読むだけの 1 時間の鍵を作る",
    "インストール先のリポジトリ一覧を GitHub から取得する。`cursor` は GitHub のページの番号",
    "`serviceId` があれば、そのサービスを作ると決める時に選べない物 (同じ名前のリポジトリを持つ別のサービスがある物と、設計書のリポジトリ) を除く。除いた分だけページは短くなる",
  ],
  "x-errors": ["422 `validation_failed`: `cursor` か `serviceId` の形が違う", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: 連携していない、App が外された、または GitHub がエラーを返した"],
  request: { query: listQuery(router).extend({ serviceId: z.uuid().optional().openapi({ param: { name: "serviceId", in: "query" }, description: "作ると決めるサービスの ID (UUID v7)。あれば、そのサービスに選べるリポジトリだけを返す" }) }) },
  responses: { 200: listResponse(Repo), ...problems(400, 401, 403, 422, 429, 500, 502) },
});

const receiveGitHubWebhookRoute = createRoute({
  method: "post",
  path: "/hooks/v1/github",
  operationId: "receiveGitHubWebhook",
  tags: ["github"],
  summary: "GitHub の Webhook を受信する",
  description: "署名、時刻、本文の SHA-256 を検証する。本文は GitHub の形式で 5MB まで、署名の合う通知は 1 分あたり 60 回まで。捨てる通知も 204 を返す。",
  "x-steps": [
    "署名の前は送信元ごとの数だけを数える。本文を 5MB まで読み、`vault` の通知の秘密で `X-Hub-Signature-256` をタイミング攻撃に強い比較で検証し、合った通知だけを全体の 1 分 60 回で数える",
    "`X-GitHub-Delivery` は UUID の形だけを確かめ、時刻の入った版 1 なら時刻が今から 5 分より離れた通知を捨てる。ほかのインストールの通知も捨てる",
    "イベントの種類ごとに、チェック結果、レビュー、Issue、App を外した事の処理に渡す。直す文と `github_deliveries` への追加を 1 回のバッチに入れ、`github_deliveries` に同じ本文の SHA-256 がある通知 (配信 ID を変えた送り直しも) では何も直さない",
    "Issue は先に `github_deliveries` に追加し、追加できた時だけ社長の `plan` のタスクを足す。足せなければその記録を消す",
    "レビュー (`pull_request_review`) と行のコメント (`pull_request_review_comment`) は、App が写した物と、持ち主 (`author_association` が OWNER) でない者の物を捨てる。残りは Issue と同じく先に `github_deliveries` に追加し、可と不可は `owner_verdict` に、行のコメントは `review_notes` に写して、不可と行のコメントは作った社員のタスクを `todo` に戻す",
    "可と不可は同じバッチで `github_reviews` に GitHub のレビュー ID ごとに最初に受けた時刻を 1 行だけ残し、タスクの出来事の ID をレビュー ID とその時刻から決める。配信 ID と本文が変わった送り直しでも、出来事とオフィスの出来事は 1 度だけ",
  ],
  "x-errors": [
    "400 `malformed_request`: 配信 ID か種類か本文の形が違う",
    "401 `unauthenticated`: 連携していない、署名がない、または一致しない",
    "413 `payload_too_large`: 本文が 5MB を超える",
    "429 `rate_limited`: 送信元ごとの数か、署名の合う通知の 1 分あたり 60 回を超えた",
  ],
  security: [],
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(400, 401, 413, 429, 500) },
});

const getGitHubRulesRoute = createRoute({
  method: "get",
  path: "/api/v1/github/rules",
  operationId: "getGitHubRules",
  tags: ["github"],
  summary: "GitHub のルール",
  "x-steps": ["`settings` から `github.rules` の最新の値を取得する"],
  responses: { 200: okResponse(GitHubRules), ...problems(401, 403, 429, 500) },
});

const updateGitHubRulesRoute = createRoute({
  method: "put",
  path: "/api/v1/github/rules",
  operationId: "updateGitHubRules",
  tags: ["github"],
  summary: "GitHub のルールを変更する",
  description: "15 分以内のパスキーの確認が必要。触れるリポジトリを変える。main に入れる条件はサービスの設定の `mergeWhen` にある。",
  "x-steps": [
    "パスキーの確認を求め、`version` が現在と一致する時だけ `settings` に `github.rules` を追加する",
    "監査ログに `github.rules` を記録する",
    "触れるリポジトリのうち公開のリポジトリに、main に入れる条件と同じルールセット「know-office」を設定し直す",
  ],
  "x-errors": ["409 `conflict`: バージョンが異なる", "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける", "502 `upstream_failed`: GitHub がエラーを返した。変えたルールと監査ログは残る"],
  "x-step-up": true,
  // 触れるリポジトリを広げると守りが弱まるので、どの変更もパスキーで確かめる
  middleware: [stepUpGate] as const,
  request: { body: { content: { "application/json": { schema: UpdateGitHubRulesInput } }, required: true } },
  responses: { 200: okResponse(GitHubRules), ...problems(400, 401, 403, 409, 413, 415, 422, 429, 500, 502) },
});

const applyGitHubRulesRoute = createRoute({
  method: "post",
  path: "/api/v1/github/rules/apply",
  operationId: "applyGitHubRules",
  tags: ["github"],
  summary: "ルールセットを掛け直す",
  description: "15 分以内のパスキーの確認が必要。設定は変えず、今の main に入れる条件のルールセットを掛け直す。",
  "x-steps": [
    "パスキーの確認を求める",
    "GitHub と連携していなければ断る",
    "同じ時の掛け直しを 1 つにする錠 (5 分) を取る。外されないまま 5 分を過ぎた錠は取り直す。取れなければ断る",
    "監査ログに `github.rules_apply` を、今の触れるリポジトリとルールの版とともに記録する。記録できなければ GitHub を呼ばない",
    "今の設定のまま、サービスのリポジトリと触れるリポジトリのうち公開のリポジトリに、ルールセット「know-office」を掛ける。同じ名前のルールセットがあれば置き換え、2 つ作らない",
    "錠を外す",
  ],
  "x-errors": [
    "409 `conflict`: GitHub と連携していない、または同じ時に別の掛け直しが動いている",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した。それまでに掛けたリポジトリは掛かったままで、監査ログは残る。押し直すと残りを掛ける",
  ],
  "x-step-up": true,
  // GitHub の側のルールセットを書き換えるので、変える時と同じくパスキーで確かめる
  middleware: [stepUpGate] as const,
  responses: { 200: okResponse(GitHubRulesApplied), ...problems(401, 403, 409, 429, 500, 502) },
});

/** 掛け直しの錠の名前と長さ。GitHub を呼ぶ口の時間切れ 10 秒をリポジトリの数だけ待っても切れない長さにする */
const APPLY_LOCK = "github.rules_apply";
const APPLY_LOCK_MS = 5 * 60_000;

/** GitHub のルート。連携、リポジトリ、ルール */
export const githubRoutes = router
  .openapi(connectGitHubRoute, async (c) => {
    let link = await loadLink(c.env);
    if (link.installation) throw new AppError("conflict", "すでに連携済み");
    // 作った App を GitHub で消していれば、App の鍵を取り消して作り直せるようにする
    if (link.app && !(await appExists(c.env, c.var.fetch, link.app, c.var.clock.now()))) {
      const dropped = await c.env.DB.prepare(DROP_GONE_APP).bind(c.var.clock.now(), link.app.version).run();
      if (dropped.meta.changes > 0) await audit(c, "github.app_gone", String(link.app.appId), { slug: link.app.slug });
      link = await loadLink(c.env);
      if (link.installation) throw new AppError("conflict", "すでに連携済み");
    }
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
    // 全体を止めた後に連携をやり直した時は、入れ直す前の世代で GitHub App の鍵の印を外す
    const { generation } = await guardDo(c.env).keyState();
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
    await guardDo(c.env).releaseKeys("github_app", generation);
    return redirect(c, "/settings");
  })
  .openapi(getGitHubLinkRoute, async (c) => {
    const link = await loadLink(c.env);
    if (link.installation) return ok(c, { state: "installed" as const });
    return ok(c, { state: link.app ? ("app_created" as const) : ("none" as const) });
  })
  .openapi(listGitHubReposRoute, async (c) => {
    const { cursor, limit, serviceId } = c.req.valid("query");
    const parsed = PageCursor.safeParse(cursor ?? "1");
    if (!parsed.success) throw new AppError("validation_failed", "cursor の形が違う", { errors: [{ pointer: "#/query/cursor", detail: "前の返事の meta.next を送る" }] });
    const page = Number(parsed.data);
    const found = await installationRepos(c.env, c.var.github, page, limit);
    const repos = serviceId === undefined ? found.repos : await choosableRepos(c.env.DB, serviceId, found.repos);
    return list(c, repos, page * limit < found.total ? String(page + 1) : null);
  })
  .openapi(getGitHubRulesRoute, async (c) => ok(c, await loadGitHubRules(c.env.DB)))
  .openapi(updateGitHubRulesRoute, async (c) => {
    const { repos, version, reason } = c.req.valid("json");
    const rules = await updateGitHubRules(c.env.DB, { repos, version, reason, now: c.var.clock.now() });
    await audit(c, "github.rules", RULES_KEY, { repos: rules.repos, version: rules.version, reason });
    // 変えたルールと記録を残してから掛け直す。GitHub が失敗してもゲートウェイの判断は新しいルールで守る
    await protectRepos(c.env, c.var.forge);
    return ok(c, rules);
  })
  .openapi(applyGitHubRulesRoute, async (c) => {
    if (!(await c.var.forge.connected())) throw new AppError("conflict", "GitHub と連携していない");
    const holder = newId(c.var.clock);
    // 同じ時の掛け直しが 2 つとも「無い」と読んで 2 つ作らないよう、1 つずつにする
    if (!(await claimLock(c.env.DB, { name: APPLY_LOCK, holder, now: c.var.clock.now(), ttlMs: APPLY_LOCK_MS }))) throw new AppError("conflict", "ほかの掛け直しが動いている");
    try {
      // PUT github/rules と同じく、記録を残してから GitHub を呼ぶ。記録が落ちれば何も掛けずに 500 で、掛かったのに残らない事を作らない
      const rules = await loadGitHubRules(c.env.DB);
      await audit(c, "github.rules_apply", RULES_KEY, { repos: rules.repos, version: rules.version });
      return ok(c, { applied: await protectRepos(c.env, c.var.forge) });
    } finally {
      await releaseLock(c.env.DB, APPLY_LOCK, holder);
    }
  });

/** GitHub の通知のルート。Access とログインセッションの外に置き、署名で確かめる */
export const hookRoutes = createRouter().openapi(receiveGitHubWebhookRoute, async (c) => {
  await receiveHook(c);
  return noContent(c);
});
