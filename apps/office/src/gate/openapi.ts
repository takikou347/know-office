// ルートの定義に使う共通の部品。失敗の応答は components/responses を指す
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { ErrorCode, ListMeta, Meta, Problem } from "@know-office/core";
import type { ZodType } from "zod";
import type { GateEnv } from "./env.ts";

/** ステータスごとの components/responses の名前と説明。v1.yaml と同じ */
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
 * 一覧を返す成功の応答の形
 * @param item 一覧の 1 件の Zod スキーマ
 * @returns createRoute の responses の 1 項目
 */
export function listResponse<T extends ZodType>(item: T) {
  return { description: "成功", content: { "application/json": { schema: z.object({ data: z.array(item), meta: ListMeta }).strict() } } };
}

/**
 * 共通のスキーマと失敗の応答を components に登録する
 * @param app ゲートウェイ
 */
export function registerComponents(app: OpenAPIHono<GateEnv>): void {
  for (const schema of [Meta, ListMeta, ErrorCode, Problem]) app.openAPIRegistry.register(String(schema.meta()?.id), schema);
  for (const [name, description] of Object.values(STATUS_RESPONSES)) {
    app.openAPIRegistry.registerComponent("responses", name, {
      description,
      content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
    });
  }
}
