# know-office

KNOW IDEA の社内の管理アプリ。AI 社員が自分で仕事を見つけて進めるのを、オーナーが眺める。おかしな動きの時だけ、オーナーが一言かける。

| 置き場 | 中身 |
| --- | --- |
| `openspec/` | 仕様(OpenSpec)。要件はここが正本 |
| `packages/core/` | 入口、作業場、画面が共に使う型と判断 |
| `apps/office/` | 画面(Vite と React)と入口(Hono)。1 つの Worker にまとめて配る |
| `apps/workspace/` | 作業場。Node.js で動くコンテナの中身 |

確かめは `pnpm install`、`pnpm typecheck`、`pnpm test`、`pnpm build`。手元で動かす時は `pnpm --filter @know-office/office dev`。

仕様は `openspec/changes/build-office/` にある。作っている所は、その中の `tasks.md` の印で分かる。
