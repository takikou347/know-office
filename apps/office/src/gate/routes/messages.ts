// 会話: 社員とのメッセージを読む、送る (社員と自動の 3.7、API の conversation)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, codePoints, log, CreateMessageInput, headChars, jstYear, Message, MESSAGE_INLINE_CHARS, type MessageOrder, newId, StaffId, type StaffState } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { createRouter } from "../app.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { announce } from "../live/publish.ts";
import { createdResponse, listQuery, listResponse, problems } from "../openapi.ts";
import { created, list } from "../respond.ts";
import { loadSwitch, OFF_HOURS_CALL } from "../services/switches.ts";
import { clockAt } from "../work/attendance.ts";
import { DELIVERY_WINDOW_MS, type DeliveryMark, deliveriesOf, deliverToRun, inRun, type PendingMessage } from "../work/deliver.ts";
import { readOrders } from "../work/chat-orders.ts";
import { type IntakeTarget, intakeMessage } from "../work/intake.ts";
import { callForMessage } from "../work/loop.ts";
import { ordersOfMessages } from "../work/orders.ts";
import { recordsOf } from "../work/nodes.ts";
import { jobOf } from "../work/roster.ts";

const router = createRouter();

const StaffParam = z.object({ staffId: StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID。役割ごとに固定" }) }).strict();

const listMessagesRoute = createRoute({
  method: "get",
  path: "/api/v1/staff/{staffId}/messages",
  operationId: "listMessages",
  tags: ["conversation"],
  summary: "社員とのメッセージ履歴",
  description: "カーソルは前のページの最後のメッセージ ID (UUID v7) で、その時刻の年から前の年へ続けて読む。",
  "x-steps": [
    "`messages` を新しい順に取得する",
    "長い発言は本文を R2 から取得する。R2 に無ければ、その発言だけ本文を空にしてエラーログに残す",
    "オーナーの発言は `message_deliveries` を ID で引き、渡した時刻と道を付ける。道が `task` なら足したタスクの ID も付ける。印が無く 24 時間を過ぎた発言は `skipped` にする",
    "オーナーの発言は `day_orders` を `message_id` で引き、会話の言葉から足した指示を付ける。取り消した指示は取り消した時刻を付ける",
  ],
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
  description: "勤務時間外で時間外の呼び出しを開いている場合は社員を呼び出す。社員への発言は、社員が走っていなければその社員のタスクにする。字数はコードポイントで数える。",
  "x-steps": [
    "`messages` に追加する。2,000 字を超える場合は本文を先に R2 の `messages/<社員 ID>/<メッセージ ID>.txt` に保存し、D1 には頭の 2,000 字を置く",
    "在籍の社員でなければ 404。`serviceId` を送った時は、そのサービスが無ければ 422",
    "今の呼び出しが走っていない (タスクを持って working、wrapping、called でない) なら、`serviceId` のサービス (省けば office) の受け付けのプロジェクトの下に、その社員のタスク (`source` `chat:<発言 ID>`、優先 0、本文は発言の全文、種類は社長が `plan`、開発担当が `build`、レビュー担当が `content`) を、同じ発言のタスクと渡した印が無い時だけ足し、同じバッチで `message_deliveries` に `task` の印と足したタスク ID を足す。足せたら出来事と監査ログ `node.create` を残し、`LiveDO` に `message_delivered` を流し、社員に知らせる (勤務時間外には呼び出さない)。足せなくても 201 を返し、訳をエラーログに `message_intake_failed` で残す。印の無い発言は次の呼び出しの頭で渡す",
    "走っている時は `serviceId` を使わず、`WorkspaceDO.message` でワークスペースの `POST /v1/messages` に渡し、受けたら `message_deliveries` に `run` の印を足す。止まったワークスペースは起こさない。渡せなければ次の呼び出しの頭で渡す",
    "設定 `workday.chatOrders` が開いていれば、`chat_order_reads` に今日の回数が上限より少ない時だけ発言の印を足し、足せた時だけ Messages API を Haiku で 1 回呼んで勤務の指示を抜き出す。使った量を `usage` に足す。抜き出した指示は指示のボタンと同じ確かめで `day_orders` に `source` `chat` と `message_id` を付けて足し、`StaffDO.order` で予定を作り直し、監査ログに `order.create` を記録する。延長はこの要求のログインセッションが 15 分以内にパスキーで確かめた時だけ足し、確かめていなければ返事に `step_up_required` の印で返す。抜き出せなくても 201 を返し、訳をエラーログに `chat_orders_failed` で残す",
    "社員が退勤していて、この発言から今日の休みを抜き出しておらず (もう休みで足さなかった時も含む)、設定 `workday.offHoursCall` が開いていれば、次のタスクを取らせて `StaffDO.call` で呼び出す。発言は最初の呼び出しの頭で渡す。取るタスクが無い時と社員ごとの 1 日の回数に届いた時は呼び出さず、タスクを todo に戻す。呼び出せなくても 201 を返し、訳をエラーログに `message_call_failed` で残す",
    "`LiveDO` に渡して画面に配信する",
  ],
  "x-errors": ["404 `not_found`: 在籍の社員でない", "409 `stopped`: 社員が停止中", "422 `validation_failed`: 選んだサービスが無い"],
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
 * @param marks 発言 ID ごとの渡した印と、会話の言葉から足した指示
 * @param marks.delivered 発言 ID ごとの渡した印
 * @param marks.orders 発言 ID ごとの指示
 * @param clock 時刻
 * @returns メッセージ
 */
async function toMessage(env: Bindings, row: MessageRow, marks: { delivered: Map<string, DeliveryMark>; orders: Map<string, MessageOrder[]> }, clock: { now(): number }): Promise<Message> {
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
  const sender = row.sender === "staff" ? "staff" : "owner";
  const mark = marks.delivered.get(row.id);
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    staffId,
    nodeId: row.node_id,
    sender,
    body,
    ...deliveryOf(sender, row.at, mark, clock.now()),
    orders: marks.orders.get(row.id) ?? [],
    taskId: sender === "owner" && mark?.via === "task" ? mark.nodeId : null,
  };
}

/**
 * 発言を渡した時刻と道を決める。印の無いオーナーの発言は、24 時間を過ぎていれば次の呼び出しでも渡さないので skipped にする
 * @param sender 発言した側
 * @param at 発言の時刻
 * @param mark 渡した印
 * @param now 今の時刻
 * @returns 渡した時刻と道
 */
function deliveryOf(sender: Message["sender"], at: number, mark: DeliveryMark | undefined, now: number): Pick<Message, "deliveredAt" | "delivery"> {
  if (sender === "staff") return { deliveredAt: null, delivery: null };
  if (mark) return { deliveredAt: mark.via === "skipped" ? null : new Date(mark.at).toISOString(), delivery: mark.via };
  return { deliveredAt: null, delivery: at < now - DELIVERY_WINDOW_MS ? "skipped" : null };
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
  const owners = shown.filter((r) => r.sender === "owner").map((r) => r.id);
  const marks = { delivered: await deliveriesOf(env.DB, owners), orders: await ordersOfMessages(env.DB, owners) };
  const items = await Promise.all(shown.map((r) => toMessage(env, r, marks, clock)));
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
  const message: Message = { id, at: new Date(at).toISOString(), staffId: input.staffId, nodeId: input.nodeId, sender: input.sender, body: input.body, deliveredAt: null, delivery: null, orders: [], taskId: null };
  const { deliveredAt: _at, delivery: _via, orders: _orders, taskId: _task, ...shown } = message;
  await announce(env, { type: "message", message: { ...shown, body: headChars(input.body, MESSAGE_INLINE_CHARS), truncated: long } }, clock);
  return message;
}

/**
 * 時間外の呼び出しを開いていれば、退勤している社員を呼び出す。呼び出せなくても発言は残すので、投げずにログとエラーログに残す
 * @param env バインディング
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @param traceId 話しかけた要求の traceId
 */
async function callOffHours(env: Bindings, staffId: StaffId, now: number, traceId: string): Promise<void> {
  try {
    const setting = await loadSwitch(env.DB, OFF_HOURS_CALL);
    if (!setting.value.enabled) return;
    const called = await callForMessage(env, staffId, now, setting.value.perDay, traceId);
    log("info", "message_call", { staffId, called });
  } catch (error) {
    log("warn", "message_call_failed", { staffId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    await recordError(env, { source: "gate", level: "warn", code: "message_call_failed", error, traceId }, clockAt(now));
  }
}

/**
 * 走っている社員の今の呼び出しに発言を渡し、渡せたら渡した時刻と道を付ける
 * @param env バインディング
 * @param message 足した発言
 * @param who 社員の状態
 * @param who.staffId 社員 ID
 * @param who.state 状態
 * @param who.nodeId 持っているタスク
 * @param pending 渡す発言
 * @param now 今の時刻
 * @returns 渡した印を付けた発言
 */
async function runOf(env: Bindings, message: Message, who: { staffId: StaffId; state: StaffState; nodeId: string | null }, pending: PendingMessage, now: number): Promise<Message> {
  const deliveredAt = await deliverToRun(env, who, pending, now);
  return deliveredAt === null ? message : { ...message, deliveredAt: new Date(deliveredAt).toISOString(), delivery: "run" };
}

/**
 * 社員への発言をその社員のタスクにし、足せたら道 task と足したタスクを付ける。足せなくても発言は残すので投げず、ログとエラーログに残す
 * @param env バインディング
 * @param message 足した発言
 * @param pending タスクにする発言
 * @param target 足す先の社員と範囲
 * @param traceId 話しかけた要求の traceId
 * @param clock 時刻
 * @returns 印を付けた発言
 */
async function intakeOf(env: Bindings, message: Message, pending: PendingMessage, target: IntakeTarget, traceId: string, clock: { now(): number }): Promise<Message> {
  const now = clock.now();
  try {
    const taskId = await intakeMessage(env, pending, now, traceId, target);
    if (taskId === null) return message;
    return { ...message, deliveredAt: new Date(now).toISOString(), delivery: "task", taskId };
  } catch (error) {
    log("warn", "message_intake_failed", { traceId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    await recordError(env, { source: "gate", level: "warn", code: "message_intake_failed", error, traceId }, clock).catch(() => undefined);
    return message;
  }
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
    // 削除した社員には話しかけない
    const job = await jobOf(c.env.DB, staffId);
    if (job === null) throw new AppError("not_found", "在籍の社員でない");
    const scope = input.serviceId ?? "office";
    if (scope !== "office" && !(await c.env.DB.prepare("SELECT 1 FROM services WHERE id = ?").bind(scope).first())) throw new AppError("validation_failed", "選んだサービスが無い");
    const status = await c.env.STAFF.get(c.env.STAFF.idFromName(staffId)).status(c.var.clock.now());
    if (status.state === "stopped") throw new AppError("stopped", "社員が止まっている");
    const message = await appendMessage(c.env, { staffId, sender: "owner", body: input.body, nodeId: input.nodeId ?? null, traceId: c.var.traceId }, c.var.clock);
    const pending = { id: message.id, at: Date.parse(message.at), body: input.body };
    // 走っていない社員への発言は、その社員のタスクにする。走っている社員には今の呼び出しに渡し、操縦を残す
    const delivered: Message = inRun(status)
      ? await runOf(c.env, message, { staffId, ...status }, pending, c.var.clock.now())
      : await intakeOf(c.env, message, pending, { staffId, job, scope }, c.var.traceId, c.var.clock);
    // 抜き出しを呼び出しより先にし、今日を休みにと言った発言では社員を呼び出さない。もう休みで足さなかった時も同じ。指示と頼みが混ざった発言の頼みを落とさないよう、指示を抜き出してもタスクにはする
    const { orders, restToday } = await readOrders(c, staffId, { id: message.id, body: input.body });
    if (status.state === "off" && !restToday) await callOffHours(c.env, staffId, c.var.clock.now(), c.var.traceId);
    const answer: Message = { ...delivered, orders };
    return created(c, answer, `/api/v1/staff/${staffId}/messages`);
  });
