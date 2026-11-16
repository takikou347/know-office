// ワークスペースの Node のサーバー (apps/workspace/src/server.ts) が受けるルートの形。社員 DO が呼び、API の文書に載せる (社員が考えるの 2 章)
import { createRoute } from "@hono/zod-openapi";
import { Health, ReasonInput, RestoreInput, RunInput, TicketInput, WorkspaceMessageInput } from "@know-office/core";
import type { ZodType } from "zod";
import { okResponse, problems } from "../openapi.ts";

const WORKSPACE_KEY = [{ workspaceKey: [] }];
const NO_CONTENT = { description: "成功。レスポンス本文なし" };

/**
 * 本文を JSON で受ける形
 * @param schema 本文の Zod スキーマ
 * @returns createRoute の request
 */
function jsonBody(schema: ZodType) {
  return { body: { required: true, content: { "application/json": { schema } } } };
}

/** ワークスペースのサーバーのルート */
export const WORKSPACE_ROUTES = [
  createRoute({
    method: "get",
    path: "/v1/health",
    operationId: "getWorkspaceHealth",
    tags: ["workspace"],
    summary: "ワークスペースの起動確認",
    "x-steps": ["`/work` に書き込めるか、SDK を読み込めたかを返す"],
    security: [],
    responses: { 200: okResponse(Health), ...problems(500) },
  }),
  createRoute({
    method: "post",
    path: "/v1/runs",
    operationId: "startRun",
    tags: ["workspace"],
    summary: "タスク 1 件分の SDK の実行を開始する",
    "x-steps": ["実行中の処理がないことを確認する", "作業トークンを保持し、`query()` を開始する", "202 を返す。進捗は `/ws/v1/events` で送る"],
    "x-errors": ["409 `conflict`: 実行中の処理がある"],
    security: WORKSPACE_KEY,
    request: jsonBody(RunInput),
    responses: { 202: { description: "受け付けた。進捗は /ws/v1/events で送られる" }, ...problems(400, 401, 409, 413, 415, 422, 500) },
  }),
  createRoute({
    method: "put",
    path: "/v1/ticket",
    operationId: "replaceTicket",
    tags: ["workspace"],
    summary: "作業トークンを新しいものに差し替える",
    "x-steps": ["保持している作業トークンを新しいものに差し替える"],
    security: WORKSPACE_KEY,
    request: jsonBody(TicketInput),
    responses: { 204: NO_CONTENT, ...problems(400, 401, 413, 415, 422, 500) },
  }),
  createRoute({
    method: "post",
    path: "/v1/messages",
    operationId: "addRunMessage",
    tags: ["workspace"],
    summary: "実行中の処理にオーナーの発言を追加する",
    "x-steps": [
      "走っている呼び出しが無ければ 409 で断る",
      "送っていない会話の記録を `/ws/v1/transcript-parts` に送ってから、今の SDK の呼び出しを止める。止めた呼び出しの結果とエラーは送らない",
      "同じ session の続きを 1 回だけ呼び、止めている間に届いた発言はまとめて 1 つの指示にする",
    ],
    "x-errors": ["409 `conflict`: 実行中の処理がない"],
    security: WORKSPACE_KEY,
    request: jsonBody(WorkspaceMessageInput),
    responses: { 204: NO_CONTENT, ...problems(400, 401, 409, 413, 415, 422, 500) },
  }),
  createRoute({
    method: "post",
    path: "/v1/abort",
    operationId: "abortRun",
    tags: ["workspace"],
    summary: "実行中の処理を中断する",
    "x-steps": [
      "送っていない会話の記録を `/ws/v1/transcript-parts` に送る",
      "実行中の処理を中断し、終わるまで待つ。中断した呼び出しの結果とエラーは `/ws/v1/events` に送らない",
      "204 を返す。走っている処理が無くても 204",
    ],
    security: WORKSPACE_KEY,
    request: jsonBody(ReasonInput),
    responses: { 204: NO_CONTENT, ...problems(400, 401, 413, 415, 422, 500) },
  }),
  createRoute({
    method: "post",
    path: "/v1/restore",
    operationId: "restoreTranscript",
    tags: ["workspace"],
    summary: "会話の記録を復元する",
    "x-steps": [
      "実行中の処理がないことを確認する。本文は 16MiB と 1KiB まで (記録は元の大きさで 12MiB まで)",
      "会話の記録を SDK の保存先に書き込み、次の `seq` (`nextSeq`) を覚える",
    ],
    "x-errors": ["409 `conflict`: 実行中の処理がある"],
    security: WORKSPACE_KEY,
    request: jsonBody(RestoreInput),
    responses: { 204: NO_CONTENT, ...problems(400, 401, 409, 413, 415, 422, 500) },
  }),
];
