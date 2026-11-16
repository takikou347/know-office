// 会話: 社員とのメッセージを読む、送る (社員と自動の 3.7、ルートの一覧の 1.6)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, codePoints, CreateMessageInput, headChars, jstYear, Message, MESSAGE_INLINE_CHARS, newId, StaffId } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { createRouter } from "../app.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { announce } from "../live/publish.ts";
import { createdResponse, listQuery, listResponse, problems } from "../openapi.ts";
import { created, list } from "../respond.ts";
import { recordsOf } from "../work/nodes.ts";

const router = createRouter();

const StaffParam = z.object({ staffId: StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID。役割ごとに固定" }) }).strict();

const listMessagesRoute = createRoute({
  method: "get",
  path: "/api/v1/staff/{staffId}/messages",
  operationId: "listMessages",
  tags: ["conversation"],
  summary: "社員とのメッセージ履歴",
  description: "カーソルは前のページの最後のメッセージ ID (UUID v7) で、その時刻の年から前の年へ続けて読む。",
  "x-steps": ["`messages` を新しい順に取得する", "長い発言は本文を R2 から取得する。R2 に無ければ、その発言だけ本文を空にしてエラーログに残す"],
  "x-errors": ["400 `malformed_request`: カーソルがメッセージ ID の形でない"],
  request: { params: StaffParam, query: listQuery(router) },
  responses: { 200: listResponse(Message), ...problems(400, 401, 403, 404, 422, 429, 500) },
});

const createMessageRoute = createRoute({
  method: "post",
  path: "/api/v1/staff/{staffId}/messages",
  operationId: "createMessage",
  tags: ["conversation"],
  summary: "社員にメッセージを送る",
  description: "勤務時間外の場合は社員を呼び出す。字数はコードポイントで数える。",
  "x-steps": [
    "`messages` に追加する。2,000 字を超える場合は本文を先に R2 の `messages/<社員 ID>/<メッセージ ID>.txt` に保存し、D1 には頭の 2,000 字を置く",
    "タスク中ならワークスペースの `POST /v1/messages` に渡し、勤務時間外なら `StaffDO.call` で呼び出す",
    "発言に含まれる勤務の指示を軽量モデルで抽出し、`day_orders` に追加する",
    "`LiveDO` に渡して画面に配信する",
  ],
  "x-errors": ["409 `stopped`: 社員が停止中"],
  request: { params: StaffParam, body: { required: true, content: { "application/json": { schema: CreateMessageInput } } } },
  responses: {
    201: createdResponse(Message),
    ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500),
  },
});

/** カーソルの形。UUID v7 だけ */
const MessageCursor = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** D1 の messages の行 */
type MessageRow = { id: string; at: number; staff_id: string; node_id: string | null; sender: string; body: string; body_key: string | null };

/**
 * 長い本文を置く R2 の鍵。確かめた社員 ID とサーバーが作った ID だけから組む
 * @param staffId 社員 ID
 * @param id メッセージ ID
 * @returns R2 の鍵
 */
export function messageKey(staffId: StaffId, id: string): string {
  return `messages/${staffId}/${id}.txt`;
}

/**
 * UUID v7 の頭の 48 ビットから作った時刻を読む
 * @param id UUID v7
 * @returns 協定世界時のミリ秒
 */
function timeOfId(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

/**
 * その年から前の年へ、バインドしてある記録の D1 を並べる
 * @param env バインディング
 * @param year 始める年
 * @returns 新しい年から並べた D1
 */
function yearsFrom(env: Bindings, year: number): D1Database[] {
  return RECORD_BINDINGS.filter((b) => Number(b.slice(4)) <= year)
    .toReversed()
    .flatMap((b) => {
      const db = env[b];
      return db ? [db] : [];
    });
}

/**
 * 行を返す形にする。長い本文は R2 から読み、鍵が決めた形でないか R2 に無ければ、その発言だけ本文を空にしてエラーログに残す
 * @param env バインディング
 * @param row 行
 * @param clock 時刻
 * @returns メッセージ
 */
async function toMessage(env: Bindings, row: MessageRow, clock: { now(): number }): Promise<Message> {
  const staffId = StaffId.parse(row.staff_id);
  let body = row.body;
  if (row.body_key !== null) {
    const object = row.body_key === messageKey(staffId, row.id) ? await env.FILES.get(row.body_key) : null;
    if (object) body = await object.text();
    else {
      body = "";
      await recordError(env, { source: "gate", level: "error", code: "message_body_missing", error: new Error(`メッセージ ${row.id} の本文が R2 に無い`) }, clock);
    }
  }
  return { id: row.id, at: new Date(row.at).toISOString(), staffId, nodeId: row.node_id, sender: row.sender === "staff" ? "staff" : "owner", body };
}

/**
 * 社員とのメッセージを新しい順に読む。カーソルの時刻の年から前の年へ続けて読む
 * @param env バインディング
 * @param staffId 社員 ID
 * @param page カーソルと件数
 * @param page.cursor 前のページの最後のメッセージ ID
 * @param page.limit 件数
 * @param clock 時刻
 * @returns メッセージと次のカーソル
 * @throws malformed_request カーソルが UUID v7 でない時
 */
export async function listMessages(env: Bindings, staffId: StaffId, page: { cursor?: string | undefined; limit: number }, clock: { now(): number }): Promise<{ items: Message[]; next: string | null }> {
  if (page.cursor !== undefined && !MessageCursor.safeParse(page.cursor).success) throw new AppError("malformed_request", "カーソルがメッセージ ID でない");
  const start = jstYear(page.cursor === undefined ? clock.now() : timeOfId(page.cursor));
  const rows: MessageRow[] = [];
  for (const db of yearsFrom(env, start)) {
    if (rows.length > page.limit) break;
    const found = await db
      .prepare("SELECT id, at, staff_id, node_id, sender, body, body_key FROM messages WHERE staff_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
      .bind(staffId, page.cursor ?? null, page.cursor ?? null, page.limit + 1 - rows.length)
      .all<MessageRow>();
    rows.push(...found.results);
  }
  const shown = rows.slice(0, page.limit);
  const items = await Promise.all(shown.map((r) => toMessage(env, r, clock)));
  return { items, next: rows.length > page.limit ? (shown.at(-1)?.id ?? null) : null };
}

/**
 * オーナーか社員の発言を足し、配信 DO に渡す。2,000 字を超える本文は先に R2 に置き、D1 には頭の 2,000 字を置く
 * @param env バインディング
 * @param input 発言
 * @param input.staffId 社員 ID
 * @param input.sender 発言した側
 * @param input.body 本文
 * @param input.nodeId タスク ID
 * @param input.traceId トレース ID
 * @param clock 時刻
 * @returns 足したメッセージ
 */
export async function appendMessage(
  env: Bindings,
  input: { staffId: StaffId; sender: "owner" | "staff"; body: string; nodeId: string | null; traceId: string | null },
  clock: { now(): number },
): Promise<Message> {
  const at = clock.now();
  const id = newId(clock);
  const long = codePoints(input.body) > MESSAGE_INLINE_CHARS;
  const key = long ? messageKey(input.staffId, id) : null;
  // R2 に置けなければ D1 にも足さない
  if (key) await env.FILES.put(key, input.body);
  try {
    await recordsOf(env, at)
      .prepare("INSERT INTO messages (id, at, staff_id, node_id, sender, body, body_key, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, at, input.staffId, input.nodeId, input.sender, headChars(input.body, MESSAGE_INLINE_CHARS), key, input.traceId)
      .run();
  } catch (error) {
    // D1 に足せなかった時は、置いた本文を残さない
    if (key) await env.FILES.delete(key).catch(() => undefined);
    throw error;
  }
  const message: Message = { id, at: new Date(at).toISOString(), staffId: input.staffId, nodeId: input.nodeId, sender: input.sender, body: input.body };
  await announce(env, { type: "message", message: { ...message, body: headChars(input.body, MESSAGE_INLINE_CHARS), truncated: long } }, clock);
  return message;
}

/** 会話のルート */
export const messageRoutes = router
  .openapi(listMessagesRoute, async (c) => {
    const { items, next } = await listMessages(c.env, c.req.valid("param").staffId, c.req.valid("query"), c.var.clock);
    return list(c, items, next);
  })
  .openapi(createMessageRoute, async (c) => {
    const { staffId } = c.req.valid("param");
    const input = c.req.valid("json");
    const status = await c.env.STAFF.get(c.env.STAFF.idFromName(staffId)).status(c.var.clock.now());
    if (status.state === "stopped") throw new AppError("stopped", "社員が止まっている");
    const message = await appendMessage(c.env, { staffId, sender: "owner", body: input.body, nodeId: input.nodeId ?? null, traceId: c.var.traceId }, c.var.clock);
    // TODO(#121): タスク中ならワークスペースの POST /v1/messages に渡し、時間外なら StaffDO.call で呼び、勤務の指示を軽いモデルで抜き出す
    return created(c, message, `/api/v1/staff/${staffId}/messages`);
  });
