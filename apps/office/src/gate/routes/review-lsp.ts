// エディタの補完の切り替え。確かめてから作った社員のワークスペースを起こすかを決め、木が今の先でなければ tarball を流し、WorkspaceDO の中継につなぐ (タスクとレビューの 3.6、API の reviews)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, decideRepo, LspTreeParams, StaffId } from "@know-office/core";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { isActive } from "../auth/session.ts";
import { sessions, stops } from "../db/main.ts";
import type { GateEnv } from "../env.ts";
import { repoScope } from "../github/rules.ts";
import { openStops, staffOf } from "../guard/actions.ts";
import { recordError } from "../ledger/errors.ts";
import { audit } from "../ledger/record.ts";
import { holdLspSlot } from "../live/lsp.ts";
import { upgradeOrigin } from "../live/origin.ts";
import { liveOf } from "../live/publish.ts";
import { problems } from "../openapi.ts";
import { findNode } from "../work/nodes.ts";
import { findReview } from "../work/review.ts";
import { currentSession } from "./sessions.ts";

const router = createRouter();

/** 起きていない時に待たせる秒 */
const RETRY_AFTER_S = 30;

const openReviewLspRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/lsp",
  operationId: "openReviewLsp",
  tags: ["reviews"],
  summary: "エディタの補完、型の誤り、定義へ移る",
  description:
    "画面と、レビューするタスクを作った社員のワークスペースの `tsc --lsp` を JSON-RPC の WebSocket でつなぐ。画面は初めて書き換えた時か、候補、型と説明、定義を求めた時に開く。上りは 1 件 1MiB (超えたら 1009)、1 分 600 回 (超えたら 1008)、下りは 1 件 4MiB (超えたら 1011) まで。ワークスペースごとに 1 本で、2 本目を受けてから前の物を 1008 で閉じる。1 時間か、10 分送りが無ければ閉じる。ログアウト、全部のログアウト、送信元の締め出し、全体の停止、ワークスペースを止めた時に閉じる。配信の同時 10 本に数える。勤務の外に `EDITOR_WAKE` で起こしたワークスペースは、接続が無くなって 10 分か、起こしてから 1 時間か、1 日 2 時間を使い切った時に止める。",
  "x-steps": [
    "`Origin` が自分の URL と一致することを確認する。違えば作業トークンを使わずに断る",
    "`nodeId` が小文字の UUID であることを確認する",
    "`Upgrade: websocket` があることを確認する",
    "配信の作業トークンを `LiveDO` で使用済みにする",
    "`reviews` を取得し、リポジトリを読む操作をルールと照らす",
    "レビューの先のコミットが 40 字の小文字の 16 進であることを確認する。ワークスペースへの道はこの 2 つだけで組む",
    "全体か作った社員が止まっていれば起こさない。勤務の外で `EDITOR_WAKE` が `on` で、ログインセッションが今も生きている時だけ、止まっているワークスペースを 1 回だけ起こしてよいとする",
    "`WorkspaceDO` で、止めている最中なら止め終わりを待ち、止まっていれば起こしてよい時だけ 1 回起こす (やり直しと通知はしない)。勤務の外に起こした時は監査ログに `workspace.wake` を残す",
    "ワークスペースの木が今の先でなければ、読む鍵で GitHub の tarball を取り、302 は `codeload.github.com` の下だけを `Authorization` を付けずに 1 回追い、ためずに流す。同じ木を同時に開いた時は 1 本だけが取り、ほかは渡し終えるのを 90 秒まで待ち、過ぎたら自分で取る",
    "`WorkspaceDO` がワークスペースの `/v1/lsp` に WebSocket を開き、101 を返して中継する。配信の同時の数に入れる",
  ],
  "x-errors": [
    "400 `malformed_request`: `Upgrade: websocket` がない",
    "401 `unauthenticated`: 作業トークンの形が違う、使用済み、または 60 秒を過ぎた",
    "403 `origin_mismatch`: Origin がない、または異なる",
    "403 `rule_denied`: ルールでリポジトリを読めない",
    "404 `not_found`: レビューが存在しない",
    "429 `rate_limited`: GitHub の上限に当たった、今日の補完で起こせる 2 時間を使い切った、または tarball を取るのがワークスペースごとに 1 時間 20 回か 1 日 100 回に届いた。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: レビューの先のコミットの形が違う、GitHub が失敗を返した、tarball が 50MiB を超えた、ワークスペースが木を断った",
    "503 `unavailable`: ワークスペースが止まっていて起こさない (勤務の間、`EDITOR_WAKE` が `off`、全体か社員の停止中)、または起きない。`Retry-After` に 30 を付ける",
  ],
  middleware: [upgradeOrigin] as const,
  request: {
    params: z.object({ nodeId: LspTreeParams.shape.nodeId.openapi({ param: { name: "nodeId", in: "path" }, description: "レビューするタスク。小文字の UUID v7" }) }).strict(),
    query: z.object({ ticket: z.string().openapi({ param: { name: "ticket", in: "query", required: true }, description: "配信の作業トークン" }) }).strict(),
  },
  responses: { 101: { description: "WebSocket に切り替えた" }, ...problems(400, 401, 403, 404, 422, 429, 500, 502, 503) },
});

/**
 * RPC を越えて code だけが残った誤りを AppError に戻す。待つ秒は RPC を越えないので付け直す
 * @param error 投げられた物
 * @throws AppError 知っている code の時
 */
function rethrowWorkspace(error: unknown): never {
  if (error instanceof AppError) throw error;
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (code === "unavailable") throw new AppError("unavailable", "ワークスペースが動いていない", { headers: { "Retry-After": String(RETRY_AFTER_S) } });
  if (code === "rate_limited") throw new AppError("rate_limited", error instanceof Error ? error.message : "多すぎる", { headers: { "Retry-After": "3600" } });
  if (code === "upstream_failed") throw new AppError("upstream_failed", "ワークスペースが木を断った");
  if (code === "not_found") throw new AppError("not_found", "コミットが無い");
  throw error;
}

/**
 * ログインセッションが今も生きているかを読み直す。確かめてから起こすまでの間にログアウトした物で起こさない
 * @param c 要求の文脈
 * @param id ログインセッションの ID
 * @param now 今の時刻
 * @returns 生きていれば true
 */
async function sessionAlive(c: Context<GateEnv>, id: string, now: number): Promise<boolean> {
  const [row] = await drizzle(c.env.DB).select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return row !== undefined && isActive(row, now);
}

/**
 * 止まっているワークスペースを起こしてよいかを決める。全体か社員が止まっていれば起こさず、勤務の間はハートビートの作り直しに任せる
 * @param c 要求の文脈
 * @param staffId 作った社員
 * @param sessionId ログインセッションの ID
 * @param now 今の時刻
 * @returns 起こしてよければ true
 */
async function mayWake(c: Context<GateEnv>, staffId: StaffId, sessionId: string, now: number): Promise<boolean> {
  const officeStopped = and(eq(stops.scope, "office"), eq(stops.target, "office"));
  const staffStopped = and(eq(stops.scope, "staff"), eq(stops.target, staffId));
  if ((await openStops(c.env.DB, or(officeStopped, staffStopped))).length > 0) return false;
  const { state } = await staffOf(c.env, staffId).status(now);
  if (state !== "off") return false;
  // 費用が出るので、オーナーの はい の後に on にする。無ければ off
  if (c.env.EDITOR_WAKE !== "on") return false;
  return sessionAlive(c, sessionId, now);
}

/**
 * tarball を流し、流す途中で GitHub の側が落ちたかを覚える。ワークスペースへの送りが落ちた訳を分けるのに使う
 * @param stream tarball
 * @returns 流れと、落ちたかを読む関数
 */
function watched(stream: ReadableStream<Uint8Array>): { body: ReadableStream<Uint8Array>; failed: () => unknown } {
  let failure: unknown = null;
  const reader = stream.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        failure = error ?? new Error("tarball が落ちた");
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { body, failed: () => failure };
}

/** エディタの補完のルート */
export const reviewLspRoutes = router.openapi(openReviewLspRoute, async (c) => {
  const session = currentSession(c);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new AppError("malformed_request", "Upgrade: websocket が無い");
  const now = c.var.clock.now();
  // 作業トークンの中身はエラーの文にも入れない
  if (!(await liveOf(c.env).redeem(c.req.valid("query").ticket, now))) throw new AppError("unauthenticated", "配信の作業トークンが使えない");
  const { nodeId } = c.req.valid("param");
  const review = await findReview(c.env.DB, nodeId);
  const decision = decideRepo({ action: "read", repo: review.repo, paths: [] }, await repoScope(c.env.DB, review.repo));
  if (!decision.allow) throw new AppError("rule_denied", decision.reason);
  // ワークスペースの道に入るので、行の値も形を確かめた物だけを渡す
  const tree = LspTreeParams.safeParse({ nodeId, sha: review.headSha });
  if (!tree.success) throw new AppError("upstream_failed", "レビューの先のコミットの形が違う");
  const staff = StaffId.safeParse((await findNode(c.env.DB, nodeId)).assignee);
  if (!staff.success) throw new AppError("not_found", "タスクを作った社員がいない");
  const staffId = staff.data;
  const { sha } = tree.data;
  const workspace = c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(staffId));
  const wake = await mayWake(c, staffId, session.id, now);
  const prepared = await workspace.lspPrepare({ nodeId, sha, wake, now }).catch(rethrowWorkspace);
  if (prepared.woke) {
    // 記録に落ちても補完は止めない
    await audit(c, "workspace.wake", staffId, { nodeId, reason: "editor" }).catch((error: unknown) => recordError(c.env, { source: "gate", level: "warn", code: "workspace_wake_audit_failed", error }, c.var.clock));
  }
  if (prepared.tree === "needed" && prepared.claim !== null) {
    const { claim } = prepared;
    let failed: (() => unknown) | null = null;
    try {
      const archive = watched(await c.var.archive(review.repo, sha));
      failed = archive.failed;
      await workspace.lspPutTree(nodeId, sha, claim, archive.body);
    } catch (error) {
      await workspace.lspDropTree(nodeId, sha, claim).catch(() => null);
      // GitHub の側が流す途中で落ちた時は、ワークスペースに届かなかった事より先にそちらを返す
      const upstream = failed?.() ?? null;
      if (upstream instanceof AppError) throw upstream;
      if (upstream !== null) throw new AppError("upstream_failed", "tarball を流せない");
      rethrowWorkspace(error);
    }
  }
  const res = await workspace.fetch("https://workspace.internal/lsp", {
    headers: { Upgrade: "websocket", "x-lsp-node": nodeId, "x-lsp-sha": sha, "x-lsp-session": session.id, "x-lsp-ip": c.var.ip, "x-lsp-at": String(now) },
  });
  if (res.status >= 400) throw new AppError("unavailable", "ワークスペースにつながらない", { headers: { "Retry-After": String(RETRY_AFTER_S) } });
  await holdLspSlot(c.env, c.var.clock, staffId, now);
  // DO の返事のヘッダーは変えられないので、セキュリティヘッダーを足せるよう、WebSocket だけを持つ返事に作り直す
  const init = { status: res.status, webSocket: res.webSocket };
  return new Response(null, init);
});
