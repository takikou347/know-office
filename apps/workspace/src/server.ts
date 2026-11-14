// ワークスペースの Node のサーバー。社員 DO だけがコンテナの番号から呼び、起動確認、タスクの開始、作業トークンの差し替えを受ける (社員が考えるの 1.3)
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, health, PROBLEMS, RunInput, TicketInput } from "@know-office/core";
import type { Runner } from "./run.ts";

/** 受ける本文の上限 (1MB) */
const MAX_BODY_BYTES = 1024 * 1024;

/** ワークスペースの DO が起こす時に鍵を渡す環境変数の名前 */
export const WORKSPACE_KEY_ENV = "WORKSPACE_KEY";

/**
 * 起こした時の鍵を環境変数から取り出して消す。SDK と社員のコマンドは子のプロセスで動き、process.env を受け継ぐので、先に消す
 * @param env 環境変数。本番は process.env
 * @returns 鍵。無ければ空
 */
export function takeWorkspaceKey(env: Record<string, string | undefined>): string {
  const key = env[WORKSPACE_KEY_ENV] ?? "";
  delete env[WORKSPACE_KEY_ENV];
  return key;
}

/**
 * SHA-256 を返す
 * @param value 文字列
 * @returns 32 バイト
 */
function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Authorization の Bearer が鍵と同じかを一定の時間で比べる。長さを漏らさないよう、両方の SHA-256 を比べる
 * @param req 要求
 * @param key ゲートウェイの鍵。空ならどれも合わない
 * @returns 合うか
 */
function fromGateway(req: IncomingMessage, key: string): boolean {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  if (key === "" || !match?.[1]) return false;
  return timingSafeEqual(sha256(match[1]), sha256(key));
}

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
 * 要求を 1 つ処理する。起動確認のほかは、ゲートウェイの鍵を確かめてから道を探す
 * @param runner タスクの呼び出し
 * @param key ゲートウェイの鍵
 * @param req 要求
 * @param res 返事
 * @throws unauthenticated ゲートウェイの鍵が無い、違う時
 * @throws not_found 無い道の時
 * @throws validation_failed 入力の形が違う時
 * @throws conflict もう走っている時
 */
async function handle(runner: Runner, key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = `${req.method ?? ""} ${req.url ?? ""}`;
  if (route === "GET /v1/health") {
    send(res, 200, { data: health("workspace"), meta: { traceId: "0".repeat(32) } });
    return;
  }
  // コンテナの中の社員からも 8080 番に届くので、ゲートウェイの鍵の無い要求は道を探す前に断る
  if (!fromGateway(req, key)) throw new AppError("unauthenticated", "ゲートウェイの鍵が無いか違う");
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
 * @param key ゲートウェイの鍵。起こしたワークスペースの DO だけが持つ
 * @returns Node の HTTP サーバー
 */
export function createWorkspaceServer(runner: Runner, key: string): Server {
  return createServer((req, res) => {
    handle(runner, key, req, res).catch((error: unknown) => {
      const known = error instanceof AppError ? error : new AppError("internal", "想定外のエラーが起きた");
      const { status, title } = PROBLEMS[known.code];
      send(res, status, { type: `urn:know-office:problem:${known.code}`, title, status, detail: known.message, code: known.code });
    });
  });
}
