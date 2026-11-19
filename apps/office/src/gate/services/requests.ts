// know-office 自身のゲートウェイが、画面の知らせた訪問を Workers Analytics Engine に 1 点ずつ書く (サービスと拡張の 3.2)
import { log, VISIT_HEADER, VisitHeader } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "../env.ts";

/**
 * 管理する Web アプリが点を書く、共通の Analytics Engine のデータセット。office は SQL API でこの名前を読む。
 * データセットは最初に書いた時に作られる: https://developers.cloudflare.com/analytics/analytics-engine/get-started/
 */
export const REQUESTS_DATASET = "knowidea_requests";

/**
 * API の呼び出しが終わった後に、訪問なら 1 点書く。index1 と blob1 は Worker のスクリプト名 (WORKER_NAME)、double1 は訪問の 1。
 * 訪問の知らせは、入口のレート制限とログインの確かめを通った呼び出し (ログインセッションがある) だけで受ける。
 * バインディングか WORKER_NAME が無い間と、書けない時は何もせず、応えは変えない。
 * 1 回の呼び出しで書ける点は 250 まで、index は 96 バイトまで: https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const countRequests = createMiddleware<GateEnv>(async (c, next) => {
  await next();
  const dataset = c.env.REQUESTS;
  const script = c.env.WORKER_NAME ?? "";
  if (!dataset || script === "") return;
  const visit = c.get("session") !== undefined && VisitHeader.safeParse(c.req.header(VISIT_HEADER)).success;
  if (!visit) return;
  try {
    // 書くのを待たない。Workers が裏で書く
    dataset.writeDataPoint({ indexes: [script], blobs: [script], doubles: [1] });
  } catch (error) {
    log("warn", "request_point_not_written", { traceId: c.var.traceId, error: error instanceof Error ? error.message : "unknown" });
  }
});
