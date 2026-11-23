# know-office

KNOW IDEA の社内の管理アプリ。AI 社員が自分でタスクを見つけて進めるのを、オーナーが眺める。おかしな動きの時だけ、オーナーが一言かける。

| 置き場 | 中身 |
| --- | --- |
| `packages/core/` | ゲートウェイ、ワークスペース、画面が共に使う型と判断 |
| `packages/requests/` | Web アプリのサービスが訪問と 5xx を Workers Analytics Engine に書く共有の型 (Worker の fetch を包む関数と wrangler の雛形) |
| `apps/office/` | 画面(Vite と React)とゲートウェイ(Hono)。1 つの Worker にまとめて配る |
| `apps/workspace/` | ワークスペース。Node.js で動くコンテナの中身 |
| `apps/office/openapi/v1.yaml` | API の文書 (OpenAPI 3.1)。ゲートウェイの `createRoute` と `core` の Zod スキーマから作る。動かしたゲートウェイの `/api/v1/docs` の Swagger UI で読める |
| `templates/workflows/` | サービスのリポジトリの `.github/workflows/` に写す `deploy.yml` と `rollback.yml` の雛形。know-office のボタンと自動停止がこれを動かして本番に出し、戻す |

確かめは `pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm e2e`。`pnpm e2e` は画面を Chrome の幅 1,280 と 360 で開き、横にはみ出さない事とゲートウェイとつながる事を見る。初めての時は `pnpm --filter @know-office/office exec playwright install chromium` でブラウザを入れる。Safari はデプロイの前に Mac で `E2E_BROWSERS=safari pnpm e2e` を 1 度流す。

## 手元で動かす

Docker も Cloudflare のアカウントも要らない。`pnpm install` の後に 1 つを流すと、http://localhost:5173 に画面とゲートウェイが Cloudflare と同じ仕組み(workerd)で立つ。初めてはマイグレーションで数分かかる。

| コマンド | 中身 |
| --- | --- |
| `pnpm local` | 手元の D1 にマイグレーションを流して起こす。データは社員 3 人だけの空から始まる |
| `pnpm local:demo` | 上に加えて、勤怠、目標とタスク、レビュー待ちと承認待ちのタスク、運用中のサービス、通知を置いて起こす (`e2e/seed.sql` と `dev/demo.sql`)。何度流しても重ならない |
| `pnpm local:reset` | 手元のデータを消す。先に Ctrl+C で止めてから流す。次の `pnpm local` で空に戻る |

- ログイン、GitHub、Claude API、Cloudflare の数は `apps/office/dev/` の代わりの物が受ける。開くとオーナーとしてログインした形になり、外へは何も送らず費用も出ない。社員への言葉には代わりの Claude が答える
- 承認や延長のようにパスキーで確かめる操作は、Mac の Touch ID かパスワードのパスキーで通す (localhost の物として登録される)
- データは `apps/office/.wrangler/state` に残り、止めて起こし直しても続きから見られる。e2e は別の置き場を使うので、ここに触らない
- 画面のファイルを直すと、開いたブラウザにすぐ出る。止めるのは Ctrl+C

ビルドの成果物、手元の Cloudflare の状態、e2e の結果は `pnpm clean` でまとめて消す。

作っている所と残りは [Issues](https://github.com/takikou347/know-office/issues) で分かる。
