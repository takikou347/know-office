// know-office 自身のゲートウェイが、画面の知らせた訪問と API の 5xx を、ほかの Web アプリと同じ共有の型で Workers Analytics Engine に 1 点ずつ書く (サービスと拡張の 3.2)
import { log, VISIT_HEADER, VisitHeader } from "@know-office/core";
import { writeRequestPoint, isServerError } from "@know-office/requests";
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "../env.ts";

export { isServerError, REQUESTS_DATASET } from "@know-office/requests";

/**
 * API の呼び出しが終わった後に、訪問か 5xx なら 1 点書く。点の形は共有の型 (@know-office/requests) と同じ。
 * 画面は 1 つのページの中で API を呼ぶので、ページの読み込みでなく、画面が開いて最初の API の呼び出しに付ける X-Visit で訪問を知らせる。
 * 訪問の知らせは、入口のレート制限とログインの確かめを通った呼び出し (ログインセッションがある) だけで受ける。
 * ルートが投げた失敗は onError が応えに直してから next() が戻るので、その 500 も数える。
 * バインディングか WORKER_NAME が無い間と、書けない時は何もせず、応えは変えない
 */
export const countRequests = createMiddleware<GateEnv>(async (c, next) => {
  await next();
  const visit = c.get("session") !== undefined && VisitHeader.safeParse(c.req.header(VISIT_HEADER)).success;
  writeRequestPoint(c.env, { visit, failed: isServerError(c.res.status) }, (error) => {
    log("warn", "request_point_not_written", { traceId: c.var.traceId, error: error instanceof Error ? error.message : "unknown" });
  });
});
