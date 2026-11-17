// まだ作っていないルートの形。API の文書にだけ載せ、ハンドラーは無い。作る時はルートのまとまりへ移し、ここから消す。デプロイの前に空にする
import type { RouteConfig } from "@hono/zod-openapi";

/** まだ作っていないルートと、受け持つ Issue */
export const PLANNED_ROUTES: readonly { route: RouteConfig; issue: string }[] = [];
