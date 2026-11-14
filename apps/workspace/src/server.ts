// ワークスペースの Node のサーバー。社員 DO だけがコンテナの番号から呼び、起動確認、タスクの開始、作業トークンの差し替えを受ける (社員が考えるの 1.3)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, health, PROBLEMS, RunInput, TicketInput } from "@know-office/core";
import type { Runner } from "./run.ts";

/** 受ける本文の上限 (1MB) */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * JSON を返す
 * @param res 返事
 * @param status ステータス
 * @param body 本文。無ければ空
 */
function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * 本文を JSON として読む
 * @param req 要求
 * @returns 読んだ物
 * @throws payload_too_large 1MB を超える時
 * @throws malformed_request JSON でない時
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new AppError("payload_too_large", "本文が大きすぎる");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("malformed_request", "本文が JSON でない");
  }
}

/**
 * 要求を 1 つ処理する
 * @param runner タスクの呼び出し
 * @param req 要求
 * @param res 返事
 * @throws not_found 無い道の時
 * @throws validation_failed 入力の形が違う時
 * @throws conflict もう走っている時
 */
async function handle(runner: Runner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = `${req.method ?? ""} ${req.url ?? ""}`;
  if (route === "GET /v1/health") {
    send(res, 200, { data: health("workspace"), meta: { traceId: "0".repeat(32) } });
    return;
  }
  if (route === "POST /v1/runs") {
    const input = RunInput.safeParse(await readJson(req));
    if (!input.success) throw new AppError("validation_failed", "タスクの形が違う");
    runner.start(input.data);
    send(res, 202);
    return;
  }
  if (route === "PUT /v1/ticket") {
    const input = TicketInput.safeParse(await readJson(req));
    if (!input.success) throw new AppError("validation_failed", "作業トークンの形が違う");
    runner.replaceTicket(input.data.ticket);
    send(res, 204);
    return;
  }
  throw new AppError("not_found", `${req.url ?? ""} は存在しない`);
}

/**
 * ワークスペースのサーバーを作る
 * @param runner タスクの呼び出し
 * @returns Node の HTTP サーバー
 */
export function createWorkspaceServer(runner: Runner): Server {
  return createServer((req, res) => {
    handle(runner, req, res).catch((error: unknown) => {
      const known = error instanceof AppError ? error : new AppError("internal", "想定外のエラーが起きた");
      const { status, title } = PROBLEMS[known.code];
      send(res, status, { type: `urn:know-office:problem:${known.code}`, title, status, detail: known.message, code: known.code });
    });
  });
}
