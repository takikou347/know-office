# know-office

KNOW IDEA の社内の管理アプリ。AI 社員が自分でタスクを見つけて進めるのを、オーナーが眺める。おかしな動きの時だけ、オーナーが一言かける。

| 置き場 | 中身 |
| --- | --- |
| `packages/core/` | ゲートウェイ、ワークスペース、画面が共に使う型と判断 |
| `apps/office/` | 画面(Vite と React)とゲートウェイ(Hono)。1 つの Worker にまとめて配る |
| `apps/workspace/` | ワークスペース。Node.js で動くコンテナの中身 |
| `apps/office/openapi/v1.yaml` | API の文書 (OpenAPI 3.1)。ゲートウェイの `createRoute` と `core` の Zod スキーマから作る。動かしたゲートウェイの `/api/v1/docs` の Swagger UI で読める |
| `templates/workflows/` | サービスのリポジトリの `.github/workflows/` に写す `deploy.yml` と `rollback.yml` の雛形。know-office のボタンと自動停止がこれを動かして本番に出し、戻す |

確かめは `pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm e2e`。`pnpm e2e` は画面を Chrome の幅 1,280 と 360 で開き、横にはみ出さない事とゲートウェイとつながる事を見る。初めての時は `pnpm --filter @know-office/office exec playwright install chromium` でブラウザを入れる。Safari はデプロイの前に Mac で `E2E_BROWSERS=safari pnpm e2e` を 1 度流す。

手元で動かす時は `pnpm dev` で、http://localhost:5173 に画面とゲートウェイが Cloudflare と同じ仕組み(workerd)で立つ。ビルドの成果物、手元の Cloudflare の状態、e2e の結果は `pnpm clean` で消す。

作っている所と残りは [Issues](https://github.com/takikou347/know-office/issues) で分かる。
