# know-office

KNOW IDEA の社内の管理アプリ。AI 社員が自分で仕事を見つけて進めるのを、オーナーが眺める。おかしな動きの時だけ、オーナーが一言かける。

| 置き場 | 中身 |
| --- | --- |
| `docs/` | 設計書。全量は `docs/README.md` |
| `openspec/` | 仕様(OpenSpec)。要件はここが正本 |
| `packages/core/` | 入口、作業場、画面が共に使う型と判断 |
| `apps/office/` | 画面(Vite と React)と入口(Hono)。1 つの Worker にまとめて配る |
| `apps/workspace/` | 作業場。Node.js で動くコンテナの中身 |

確かめは `pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm e2e`。`pnpm e2e` は画面を Chrome と Safari の 3 つの幅(360、820、1440)で開き、横にはみ出さない事と入口とつながる事を見る。初めての時は `pnpm --filter @know-office/office exec playwright install chromium webkit` でブラウザを入れる。

手元で動かす時は `pnpm dev` で、http://localhost:5173 に画面と入口が Cloudflare と同じ仕組み(workerd)で立つ。ビルドの成果物、手元の Cloudflare の状態、e2e の結果は `pnpm clean` で消す。

仕様は `openspec/changes/build-office/` にある。作っている所は、その中の `tasks.md` の印で分かる。
