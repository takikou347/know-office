// 成功の返し方。本文は data と meta だけ。c.json() を直に呼ばず、ここを通す
import type { Context } from "hono";
import type { GateEnv } from "./env.ts";

/**
 * 200 で 1 件か配列を返す
 * @param c 要求の文脈
 * @param data ルートが返す物
 * @returns { data, meta } の 200
 */
export function ok<T>(c: Context<GateEnv>, data: T) {
  return c.json({ data, meta: { traceId: c.var.traceId } }, 200);
}

/**
 * 200 で一覧を返す。next は次のページのカーソルで、最後のページでは null
 * @param c 要求の文脈
 * @param items 一覧の 1 ページ
 * @param next 次のページのカーソル
 * @returns { data, meta: { traceId, next } } の 200
 */
export function list<T>(c: Context<GateEnv>, items: T[], next: string | null) {
  return c.json({ data: items, meta: { traceId: c.var.traceId, next } }, 200);
}

/**
 * 201 で作った物を返し、Location に作った物の URL を入れる
 * @param c 要求の文脈
 * @param data 作った物
 * @param location 作った物の URL
 * @returns { data, meta } の 201
 */
export function created<T>(c: Context<GateEnv>, data: T, location: string) {
  c.header("Location", location);
  return c.json({ data, meta: { traceId: c.var.traceId } }, 201);
}

/**
 * 204 で本文を返さない
 * @param c 要求の文脈
 * @returns 本文の無い 204
 */
export function noContent(c: Context<GateEnv>) {
  return c.body(null, 204);
}
