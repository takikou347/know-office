// まだ作っていないルートの形。API の文書にだけ載せ、ハンドラーは無い。作る時はルートのまとまりへ移し、ここから消す。デプロイの前に空にする
import { createRoute, z } from "@hono/zod-openapi";
import { problems } from "../openapi.ts";

const openReviewLspRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/lsp",
  operationId: "openReviewLsp",
  tags: ["reviews"],
  summary: "コード補完と定義へのジャンプ",
  "x-steps": ["`Origin` を検証する", "ワークスペースを起動し、101 を返して TypeScript の言語サーバーに接続する"],
  "x-errors": ["403 `origin_mismatch`: Origin が異なる", "503 `unavailable`: ワークスペースが起動しない"],
  request: { params: z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict() },
  responses: { 101: { description: "WebSocket に切り替えた。ワークスペースを起動する" }, ...problems(401, 403, 404, 429, 500, 503) },
});

/** まだ作っていないルートと、受け持つ Issue */
export const PLANNED_ROUTES = [
  { route: openReviewLspRoute, issue: "#110" },
];
