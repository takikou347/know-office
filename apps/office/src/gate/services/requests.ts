// know-office 自身のゲートウェイが、画面の知らせた訪問と API の 5xx を Workers Analytics Engine に 1 点ずつ書く (サービスと拡張の 3.2)
import { log, VISIT_HEADER, VisitHeader } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "../env.ts";

/**
 * 管理する Web アプリが点を書く、共通の Analytics Engine のデータセット。office は SQL API でこの名前を読む。
 * データセットは最初に書いた時に作られる: https://developers.cloudflare.com/analytics/analytics-engine/get-started/
 */
export const REQUESTS_DATASET = "knowidea_requests";

/**
 * アプリが返した 5xx か。500 から 599 だけで、429 や 401 などの 4xx は数えない
 * @param status 応えの HTTP ステータス
 * @returns 5xx か
 */
export function isServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * API の呼び出しが終わった後に、訪問か 5xx なら 1 点書く。index1 と blob1 は Worker のスクリプト名 (WORKER_NAME)、double1 は訪問なら 1、double2 は 5xx なら 1。
 * 訪問で 5xx なら 1 点に両方を書き、どちらでもない呼び出しには書かない。
 * 訪問の知らせは、入口のレート制限とログインの確かめを通った呼び出し (ログインセッションがある) だけで受ける。
 * ルートが投げた失敗は onError が応えに直してから next() が戻るので、その 500 も数える。
 * バインディングか WORKER_NAME が無い間と、書けない時は何もせず、応えは変えない。
 * 1 回の呼び出しで書ける点は 250 まで、index は 96 バイトまで: https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const countRequests = createMiddleware<GateEnv>(async (c, next) => {
  await next();
  const dataset = c.env.REQUESTS;
  const script = c.env.WORKER_NAME ?? "";
  if (!dataset || script === "") return;
  const visit = c.get("session") !== undefined && VisitHeader.safeParse(c.req.header(VISIT_HEADER)).success;
  const failed = isServerError(c.res.status);
  if (!visit && !failed) return;
  try {
    // 書くのを待たない。Workers が裏で書く
    dataset.writeDataPoint({ indexes: [script], blobs: [script], doubles: [visit ? 1 : 0, failed ? 1 : 0] });
  } catch (error) {
    log("warn", "request_point_not_written", { traceId: c.var.traceId, error: error instanceof Error ? error.message : "unknown" });
  }
});
