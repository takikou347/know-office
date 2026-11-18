// サービス: アイデアから運用まで。案を足し、一覧と詳細を読み、オーナーが段階を移す (API の services、サービスと拡張の 3.1)
import { createRoute, z } from "@hono/zod-openapi";
import { AdvanceInput, AppError, CreateIdeaInput, Deployment, RollbackInput, ServiceCard, ServiceDetail, ServiceIssues, ServiceStage } from "@know-office/core";
import { createRouter } from "../app.ts";
import { audit } from "../ledger/record.ts";
import { createdResponse, listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { accepted, created, list, ok } from "../respond.ts";
import { rollbackService } from "../services/rollback.ts";
import { loadServiceIssues } from "../services/issues.ts";
import { advanceService, createIdea, listServices, loadService, toCard } from "../services/flow.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ServiceParam = z.object({ serviceId: z.uuid().openapi({ param: { name: "serviceId", in: "path" }, description: "UUID v7" }) }).strict();

const listServicesRoute = createRoute({
  method: "get",
  path: "/api/v1/services",
  operationId: "listServices",
  tags: ["services"],
  summary: "サービスの一覧",
  "x-steps": ["`services` を段階で絞り込んで取得する"],
  request: { query: listQuery(router).extend({ stage: ServiceStage.optional().openapi({ param: { name: "stage", in: "query" } }) }) },
  responses: { 200: listResponse(ServiceCard), ...problems(400, 401, 403, 422, 429, 500) },
});

const createIdeaRoute = createRoute({
  method: "post",
  path: "/api/v1/services",
  operationId: "createIdea",
  tags: ["services"],
  summary: "アイデアを追加する",
  "x-steps": ["`services` に段階 `idea` で追加し、`service_events` に追加する", "監査ログに `service.create` を記録する"],
  request: { body: jsonBody(CreateIdeaInput) },
  responses: {
    201: createdResponse(ServiceCard),
    ...problems(400, 401, 403, 413, 415, 422, 429, 500),
  },
});

const getServiceRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{serviceId}",
  operationId: "getService",
  tags: ["services"],
  summary: "サービスの詳細",
  "x-steps": [
    "`services` と `service_events` を取得し、検討の材料を R2 の `study_key` から読む",
    "種類ごとの様子を組み立てる。ライブラリは最新の `release` の版とそろい、最新の `deploy` (npm への公開の結果)、使っているサービスごとの最新の `uses` の版。Web アプリは最新の `deploy` と `rollback`、`service_metrics` の最新の利用者数と直前 24 時間の失敗率、`usage` の今月の費用。コンテンツは `deploy` の一覧と、直前 24 時間の読まれた数",
  ],
  "x-errors": ["404 `not_found`: サービスが存在しない"],
  request: { params: ServiceParam },
  responses: { 200: okResponse(ServiceDetail), ...problems(401, 403, 404, 429, 500) },
});

const getServiceIssuesRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{serviceId}/issues",
  operationId: "getServiceIssues",
  tags: ["services"],
  summary: "サービスの Issue の木",
  description: "親 Issue と子 Issue、子と同じ番号の開発担当のタスク、設計書の PR、サービスに進められるかを返す。子は番号の若い方から 500 件までで、運用の子が積み重なっても返事が大きくなり過ぎないようにする。",
  "x-steps": [
    "サービスを取得する。設計書より前の段階では、親が無い空の木を返す",
    "`dev_issues` のそのサービスの親と子 (番号の若い方から 500 件まで) を読み、子と同じ番号の `nodes` のタスクの状態と PR の番号を付ける",
    "設計書を書くタスクの PR と、同じ時に直す設計書の PR (`task_docs`) を並べる",
    "`ready` は、機能の親 (運用の親と子が 0 件の親を除く) がすべて閉じていて、入れて閉じた親が 1 つ以上ある事。サービスに進められる通知と同じ条件で読む",
  ],
  "x-errors": ["404 `not_found`: サービスが存在しない"],
  request: { params: ServiceParam },
  responses: { 200: okResponse(ServiceIssues), ...problems(401, 403, 404, 429, 500) },
});

const advanceServiceRoute = createRoute({
  method: "post",
  path: "/api/v1/services/{serviceId}/advance",
  operationId: "advanceService",
  tags: ["services"],
  summary: "段階を進める、見送る、終了する",
  "x-steps": [
    "サービスを取得し、現在の段階から移れる段階かを確認する。移れるのは `idea` から `study` か `dropped`、`study` から `prototype` か `dropped`、`prototype` から `service` か `dropped`、`service` から `operation` か `closed`、`operation` から `closed`",
    "`prototype` に進める場合は担当の社員を `staffId` で、リポジトリを `repo` で決める。`repo` は `prototype` に進める時だけ受ける。`dropped` にする場合は理由を `dropped_reason` に残す",
    "`repo` は、GitHub と連携していて、GitHub App のインストールで選んだリポジトリの中にある事を `GET /installation/repositories` で確かめる",
    "`service` に進める場合は、サービスの `deployWhen` を確かめる。オーナーの承認は、この操作そのもの。`checks` と `reviewer` を求める時だけ、GitHub とつないでいる事を確かめ、既定のブランチの先のコミットのチェックが全部通っている事と、`reviews` にそのコミットをレビュー担当が承認した行がある事を確かめる。足りなければ何も書かずに断り、足りない条件を `detail` に並べる",
    "`study` に進める場合は、office の受け付けのプロジェクトの下に置く、似た物、作る量、セキュリティの要る所を調べる社長のタスクを組み立てる",
    "読んだ段階のままで、`repo` を決める時は確かめた時の連携 (`vault` の `github_installation` の版) のままの時だけ、`service_events` への追加、調べるタスクの追加、`services` の更新を 1 回のバッチで書く。どれかが失敗すれば、どれも書かない",
    "監査ログに `service.advance` を記録する",
  ],
  "x-errors": [
    "404 `not_found`: サービスが存在しない",
    "409 `conflict`: 移れない段階、読んだ後に段階が変わった、GitHub と連携していないのに `repo` を決めた、確かめた後に連携が変わった、または `service` に進めるのに `deployWhen` がそろっていない (GitHub とつないでいなくて確かめられない時も)",
    "422 `validation_failed`: `prototype` に進めるのに `staffId` か `repo` が無い、`prototype` でない段階に `repo` を送った、または `repo` が触れるリポジトリに無い",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した (先のコミットかチェックを読めない時も)",
  ],
  request: { params: ServiceParam, body: jsonBody(AdvanceInput) },
  responses: { 200: okResponse(ServiceCard), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
});

const rollbackServiceRoute = createRoute({
  method: "post",
  path: "/api/v1/services/{serviceId}/rollback",
  operationId: "rollbackService",
  tags: ["services"],
  summary: "前のバージョンにロールバックする",
  description: "15 分以内のパスキーの確認が必要。",
  "x-steps": [
    "サービスを取得し、Web アプリで、リポジトリがある事を確かめる",
    "`locks` の `service.rollback:<サービス ID>` を 10 分の長さで 1 文で取る。取れなければ断る。取った錠は切れるまで持ち、直前の戻しと同時の戻しを重ねない",
    "そのリポジトリの既定のブランチを読み、`rollback.yml` を GitHub App で動かす (`actions` の書きに絞った鍵)。失敗したら錠を外し、何も残さない",
    "`service_events` への `rollback` の追加と、通知 `service_rollback` を 1 回のバッチで書く。書けなければ、GitHub には届いているので、エラーログと通知 `service_rollback_unrecorded` に残す",
    "監査ログに `service.rollback` を記録する",
  ],
  "x-errors": [
    "404 `not_found`: サービスが存在しない",
    "409 `conflict`: Web アプリではない、リポジトリが無い、または直前 10 分の間に戻したか戻している最中",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した",
  ],
  "x-step-up": true,
  middleware: [stepUpGate] as const,
  request: { params: ServiceParam, body: jsonBody(RollbackInput) },
  responses: { 202: okResponse(Deployment, "受け付けた。処理は非同期で完了する"), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
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
  .openapi(getServiceIssuesRoute, async (c) => {
    return ok(c, await loadServiceIssues(c.env, c.req.valid("param").serviceId));
  })
  .openapi(advanceServiceRoute, async (c) => {
    const { serviceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const row = await advanceService(c.env, serviceId, input, { by: "owner", now: c.var.clock.now(), traceId: c.var.traceId }, c.var.github, c.var.forge);
    await audit(c, "service.advance", serviceId, { to: input.to, reason: input.reason, ...(input.repo === undefined ? {} : { repo: input.repo }) });
    return ok(c, toCard(row));
  })
  .openapi(rollbackServiceRoute, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const deployment = await rollbackService(c.env, c.var.forge, { serviceId, by: "owner", reason, now: c.var.clock.now() });
    // 手で戻す時は直前の戻しを 409 で断るので、null は返らない
    if (!deployment) throw new AppError("internal", "戻しを受け付けられなかった");
    await audit(c, "service.rollback", serviceId, { reason, deploymentId: deployment.id });
    return accepted(c, deployment);
  });
