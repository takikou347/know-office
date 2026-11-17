// ワークスペースの Node のサーバー。社員 DO だけがコンテナの番号から呼び、起動確認、タスクの開始、作業トークンの差し替え、オーナーの発言、中断、会話の記録の復元、エディタの補完の木と接続を受ける (社員が考えるの 2 章、3.7、3.8、仕事とレビューの 3.6)
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { AppError, health, log, LspTreeParams, PROBLEMS, ReasonInput, RESTORE_BODY_BYTES, RestoreInput, RunInput, TicketInput, WORKSPACE_KEY_ENV, WorkspaceMessageInput } from "@know-office/core";
import { WebSocketServer } from "ws";
import type { LspHub } from "./lsp-hub.ts";
import type { Runner } from "./run.ts";

/** 受ける本文の上限 (1MB) */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 起こした時の鍵を環境変数から取り出し、process.env から消す。SDK と社員のコマンドは子のプロセスで動き、process.env を受け継ぐので、先に消す
 * 消しても /proc/<pid>/environ には残るが、サーバーは root で動き、社員は staff に落とした子のプロセスで動くので、そこもメモリも読めない
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
 * @param limit 受ける本文の上限
 * @returns 読んだ物
 * @throws payload_too_large 上限を超える時
 * @throws malformed_request JSON でない時
 */
async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > limit) throw new AppError("payload_too_large", "本文が大きすぎる");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("malformed_request", "本文が JSON でない");
  }
}

/** 補完の接続で画面から受ける 1 件の上限 (1MiB)。ゲートウェイの上りの上限と同じ */
const LSP_MESSAGE_BYTES = 1024 * 1024;

/**
 * 道の 1 段を読む。%2F などを戻した後で形を確かめるので、戻せない物は形の誤りにする
 * @param segment 道の 1 段
 * @returns 戻した物
 * @throws validation_failed 戻せない時
 */
function decodeSegment(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    throw new AppError("validation_failed", "道の形が違う");
  }
}

/**
 * 木の名前を確かめる。道を組む前に、小文字の UUID と 40 字の小文字の 16 進のほかを断る
 * @param nodeId タスク
 * @param sha コミット
 * @returns 確かめた名前
 * @throws validation_failed 形が違う時
 */
function treeParams(nodeId: string | null, sha: string | null): LspTreeParams {
  const parsed = LspTreeParams.safeParse({ nodeId, sha });
  if (!parsed.success) throw new AppError("validation_failed", "木の名前の形が違う");
  return parsed.data;
}

/**
 * エディタの補完の木の道 (/v1/lsp/trees/...) を処理する
 * @param lsp 補完の接続
 * @param req 要求
 * @param res 返事
 * @returns 処理したか
 * @throws validation_failed 木の名前の形が違う時、木を確かめて断った時
 * @throws payload_too_large 木が大きすぎる時
 * @throws not_found 今の木が無い時
 */
async function handleTrees(lsp: LspHub, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const parts = path.split("/");
  if (parts.length < 5 || parts[1] !== "v1" || parts[2] !== "lsp" || parts[3] !== "trees") return false;
  const { trees } = lsp.deps;
  if (req.method === "PUT" && parts.length === 6) {
    const params = treeParams(decodeSegment(parts[4]), decodeSegment(parts[5]));
    // 宣言した長さで先に断り、読まずに返す
    if (Number(req.headers["content-length"] ?? "0") > trees.limits.gzBytes) throw new AppError("payload_too_large", "木が大きすぎる");
    await trees.receive(params, req);
    send(res, 204);
    return true;
  }
  if (req.method === "GET" && parts.length === 5) {
    const nodeId = treeParams(decodeSegment(parts[4]), "0".repeat(40)).nodeId;
    const sha = trees.current(nodeId);
    if (sha === null) throw new AppError("not_found", "今の木が無い");
    send(res, 200, { data: { sha } });
    return true;
  }
  return false;
}

/**
 * 要求を 1 つ処理する。起動確認のほかは、ゲートウェイの鍵を確かめてから道を探す
 * @param runner タスクの呼び出し
 * @param key ゲートウェイの鍵
 * @param lsp エディタの補完の接続。無ければ補完の道は無い
 * @param req 要求
 * @param res 返事
 * @throws unauthenticated ゲートウェイの鍵が無い、違う時
 * @throws not_found 無い道の時
 * @throws validation_failed 入力の形が違う時
 * @throws conflict もう走っている時、走っていない時の発言
 */
async function handle(runner: Runner, key: string, lsp: LspHub | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = `${req.method ?? ""} ${req.url ?? ""}`;
  if (route === "GET /v1/health") {
    send(res, 200, { data: health("workspace"), meta: { traceId: "0".repeat(32) } });
    return;
  }
  // コンテナの中の社員からも 8080 番に届くので、ゲートウェイの鍵の無い要求は道を探す前に断る
  if (!fromGateway(req, key)) {
    // 中の社員が試した跡を残す。本文と Authorization は出さない
    log("warn", "workspace_unauthenticated", { method: req.method ?? "", route: (req.url ?? "").split("?")[0] });
    throw new AppError("unauthenticated", "ゲートウェイの鍵が無いか違う");
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
  if (route === "POST /v1/messages") {
    const input = WorkspaceMessageInput.safeParse(await readJson(req));
    if (!input.success) throw new AppError("validation_failed", "発言の形が違う");
    await runner.addMessage({ body: input.data.body, at: Date.parse(input.data.at) });
    send(res, 204);
    return;
  }
  if (route === "POST /v1/abort") {
    const input = ReasonInput.safeParse(await readJson(req));
    if (!input.success) throw new AppError("validation_failed", "理由の形が違う");
    // 送っていない会話の記録を送り終えてから返す。社員 DO はこの後にコンテナを止める
    await runner.abort(input.data.reason);
    send(res, 204);
    return;
  }
  if (route === "POST /v1/restore") {
    // 走っている間は、本文を読む前に断る
    if (runner.running) throw new AppError("conflict", "実行中の処理がある");
    const input = RestoreInput.safeParse(await readJson(req, RESTORE_BODY_BYTES));
    if (!input.success) throw new AppError("validation_failed", "会話の記録の形が違う");
    await runner.restore(input.data);
    send(res, 204);
    return;
  }
  if (lsp !== undefined && (await handleTrees(lsp, req, res))) return;
  throw new AppError("not_found", `${req.url ?? ""} は存在しない`);
}

/**
 * 切り替えを断る。WebSocket に替える前なので、HTTP の返事を書いて閉じる
 * @param socket 接続
 * @param status ステータス
 */
function refuseUpgrade(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
}

/**
 * エディタの補完の切り替え (GET /v1/lsp?nodeId=&sha=) を受ける。ゲートウェイの鍵、木の名前の形、木の有る無しの順に確かめてから WebSocket に替える
 * @param lsp 補完の接続
 * @param wss WebSocket の受け手
 * @param key ゲートウェイの鍵
 * @param req 要求
 * @param socket 接続
 * @param head 先に読んだ物
 */
function upgradeLsp(lsp: LspHub | undefined, wss: WebSocketServer, key: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const [path = "", query = ""] = (req.url ?? "").split("?");
  if (!fromGateway(req, key)) {
    log("warn", "workspace_unauthenticated", { method: req.method ?? "", route: path });
    refuseUpgrade(socket, 401);
    return;
  }
  if (lsp === undefined || path !== "/v1/lsp") {
    refuseUpgrade(socket, 404);
    return;
  }
  const search = new URLSearchParams(query);
  const parsed = LspTreeParams.safeParse({ nodeId: search.get("nodeId"), sha: search.get("sha") });
  if (!parsed.success) {
    refuseUpgrade(socket, 422);
    return;
  }
  const params = parsed.data;
  if (!existsSync(lsp.deps.trees.dir(params))) {
    refuseUpgrade(socket, 404);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      lsp.open(params, {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        onMessage: (listener) => ws.on("message", (data, isBinary) => listener(Buffer.isBuffer(data) ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.concat(data)), isBinary)),
        onClose: (listener) => ws.on("close", listener),
        // 枠が 1MiB を超えた時などに ws は error を出す。受け手が無いと root のサーバーが落ちるので受け、記録して閉じる
        onError: (listener) =>
          ws.on("error", (error) => {
            log("warn", "lsp_ws_error", { error: error.name, code: "code" in error ? String(error.code) : "" });
            listener();
          }),
      });
    } catch (error) {
      log("error", "lsp_open_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  });
}

/**
 * ワークスペースのサーバーを作る
 * @param runner タスクの呼び出し
 * @param key ゲートウェイの鍵。起こしたワークスペースの DO だけが持つ
 * @param lsp エディタの補完の接続。省くと補完の道を持たない
 * @returns Node の HTTP サーバー
 */
export function createWorkspaceServer(runner: Runner, key: string, lsp?: LspHub): Server {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LSP_MESSAGE_BYTES });
  const server = createServer((req, res) => {
    handle(runner, key, lsp, req, res).catch((error: unknown) => {
      const known = error instanceof AppError ? error : new AppError("internal", "想定外のエラーが起きた");
      const { status, title } = PROBLEMS[known.code];
      // 本文を読み切る前に返した時は、残りを読まずに閉じる
      if (!req.complete) res.setHeader("connection", "close");
      send(res, status, { type: `urn:know-office:problem:${known.code}`, title, status, detail: known.message, code: known.code });
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => upgradeLsp(lsp, wss, key, req, socket, head));
  return server;
}
