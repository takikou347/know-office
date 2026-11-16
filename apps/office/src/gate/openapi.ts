// ルートの定義に使う共通の部品。失敗の応答は components/responses を指す
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { ErrorCode, ListMeta, Meta, Problem } from "@know-office/core";
import type { ZodType } from "zod";
import type { GateEnv } from "./env.ts";

/** ステータスごとの components/responses の名前と説明 */
export const STATUS_RESPONSES = {
  400: ["BadRequest", "リクエストを解釈できない。JSON として不正か、未知のクエリパラメーターがある"],
  401: ["Unauthorized", "ログインの証明、ログインセッション、作業トークンがない、または無効。パスキーの確認が期限切れ"],
  403: ["Forbidden", "オーナーではない、ロックアウト中、Origin が異なる、ルールで禁止された操作"],
  404: ["NotFound", "ルートまたは対象のリソースが存在しない"],
  409: ["Conflict", "リソースのバージョンが変わった、または停止中の範囲への操作"],
  413: ["PayloadTooLarge", "リクエスト本文が大きすぎる。上限は 1MB、GitHub の Webhook は 5MB"],
  415: ["UnsupportedMediaType", "Content-Type が application/json ではない"],
  422: ["UnprocessableContent", "JSON は解釈できたが、入力の検証に失敗した。errors に項目ごとの理由"],
  429: ["TooManyRequests", "レート制限を超えた。Retry-After に再試行までの秒数"],
  500: ["InternalError", "想定外のエラー。詳細は返さず、エラーログにだけ記録する"],
  502: ["BadGateway", "GitHub または Anthropic がエラーを返した"],
  503: ["Unavailable", "ワークスペースが起動していない。Retry-After に再試行までの秒数"],
} as const;

/** Retry-After を返す失敗のステータス */
const RETRY_AFTER_STATUSES: ReadonlySet<string> = new Set(["429", "503"]);

/** 失敗として返すステータス */
export type ProblemStatus = keyof typeof STATUS_RESPONSES;

/**
 * 失敗の応答を components/responses への参照で並べる
 * @param statuses 返し得る失敗のステータス
 * @returns createRoute の responses に足す物
 */
export function problems<S extends ProblemStatus>(...statuses: S[]): Partial<Record<S, { $ref: string }>> {
  const out: Partial<Record<S, { $ref: string }>> = {};
  for (const status of statuses) out[status] = { $ref: `#/components/responses/${STATUS_RESPONSES[status][0]}` };
  return out;
}

/**
 * 1 件を返す成功の応答の形
 * @param data 返す物の Zod スキーマ
 * @param description 応答の説明
 * @returns createRoute の responses の 1 項目
 */
export function okResponse<T extends ZodType>(data: T, description = "成功") {
  return { description, content: { "application/json": { schema: z.object({ data, meta: Meta }).strict() } } };
}

/**
 * 作った 1 件を返す成功の応答の形。Location に作った物の URL を返す
 * @param data 返す物の Zod スキーマ
 * @returns createRoute の responses の 1 項目
 */
export function createdResponse<T extends ZodType>(data: T) {
  return { ...okResponse(data, "作成した"), headers: { Location: { description: "作成したリソースの URL", schema: { type: "string" as const } } } };
}

/**
 * 一覧を返す成功の応答の形
 * @param item 一覧の 1 件の Zod スキーマ
 * @returns createRoute の responses の 1 項目
 */
export function listResponse<T extends ZodType>(item: T) {
  return { description: "成功", content: { "application/json": { schema: z.object({ data: z.array(item), meta: ListMeta }).strict() } } };
}

/**
 * 一覧のクエリ (cursor と limit) を作る。components/parameters を指すよう、ルートを書く Hono の登録簿に置く
 * @param router ルートのまとまりの Hono
 * @returns `.strict()` を付けた一覧のクエリの Zod スキーマ
 */
export function listQuery(router: OpenAPIHono<GateEnv>) {
  const cursor = router.openAPIRegistry.registerParameter("Cursor", z.string().optional().openapi({ description: "一覧の次のページのカーソル。前のレスポンスの meta.next", param: { name: "cursor", in: "query", description: "前のレスポンスの meta.next" } }));
  const limit = router.openAPIRegistry.registerParameter("Limit", z.coerce.number().int().min(1).max(100).default(50).openapi({ description: "一覧の 1 ページの件数", param: { name: "limit", in: "query" } }));
  return z.object({ cursor, limit }).strict();
}

/**
 * 共通のスキーマと失敗の応答を components に登録する
 * @param app ゲートウェイ
 */
export function registerComponents(app: OpenAPIHono<GateEnv>): void {
  for (const schema of [Meta, ListMeta, ErrorCode, Problem]) app.openAPIRegistry.register(String(schema.meta()?.id), schema);
  for (const [status, [name, description]] of Object.entries(STATUS_RESPONSES)) {
    app.openAPIRegistry.registerComponent("responses", name, {
      description,
      // 429 と 503 は Retry-After で再試行までの秒数を返す (API の決まりの 4.3)
      ...(RETRY_AFTER_STATUSES.has(status) ? { headers: { "Retry-After": { description: "再試行までの秒数", schema: { type: "integer" } } } } : {}),
      content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
    });
  }
}
