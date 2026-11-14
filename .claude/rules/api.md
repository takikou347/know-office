---
paths:
  - "apps/office/src/gate/**"
  - "apps/office/openapi/**"
  - "packages/core/src/schemas/**"
  - "packages/core/src/errors.ts"
---

# API の書き方

正本は knowidea の `../knowidea/services/know-office/docs/04-detail/1-api.md` (決まり)、`2-routes.md` (全ルートと処理の順)、`3-data.md` (全テーブル)。05-conventions.md の 3.3。全文を読まず、作るルートとテーブルの行を grep で引く。

- ルートを足す、変える時は、先に `apps/office/openapi/v1.yaml` (OpenAPI 3.1) を直し、その形でコードを書く。v1.yaml は手で書き、テスト (`test/gate/openapi.test.ts`) がコードのルートとスキーマが同じかを確かめる。同じ時に knowidea で `python3 tools/routes_md.py ../know-office/apps/office/openapi/v1.yaml` を走らせ、`2-routes.md` を作り直す
- パスは小文字の kebab-case の名詞の複数形 (`/api/v1/audit-logs`)。1 つしかない物は単数 (`/me`、`/guard/state`)。名詞で表せない操作だけ末尾に動詞 1 語を置いて `POST`。全部の置き換えは `PUT`、一部は `PATCH`
- パスの変数は `{<物>Id}`、`operationId` は `<動詞><物>` の camelCase (`listStops`)、`tags` は物のまとまりごと。`components/schemas` の名前と Zod スキーマの名前を同じにする
- キー、クエリ、パスの変数は camelCase。GitHub が決めたクエリ (`installation_id`) だけはそのまま。種類の値は snake_case
- ルートは `@hono/zod-openapi` の `createRoute` で書き、入力と返す形は `core` の Zod スキーマを使う。ハンドラーの中で入力を確かめ直さない
- 成功は `ok(c, data)`、`list(c, items, next)`、`created(c, data, location)`、`noContent(c)` で返し、`c.json()` を直に呼ばない。本文は `data` と `meta` だけ。`meta` は `traceId` を持ち、一覧の `meta` は `next` (次のカーソル、無ければ `null`) も持つ
- 失敗は `AppError` を投げ、`app.onError` が RFC 9457 の problem+json (`type`、`title`、`status`、`detail`、`instance`、`code`、`traceId`、422 だけ `errors`) に直す。ハンドラーの中で組まない
- `code` は `core` の `ErrorCode` に並べる。500 は `detail` に中身を入れない
- ステータスコードは 1-api.md の 3.1 の表だけから選ぶ。分け方は 401 (誰か分からない) → 403 (許さない) → 404 (無い) の順に確かめる
- 足すだけの変更は v1 のまま入れる。消す、名前や型や意味を変える、要る入力を足す変更は `/api/v2/` を足す。`info.version` は足したら minor、直したら patch
- 画面は Hono の RPC で同じ型を受け、`fetch` を手で書かない
- 時刻は RFC 3339 の協定世界時、日は日本時間の `YYYY-MM-DD`、ID は UUID v7、お金は `...MicroUsd` の整数
- 一覧は `?cursor=` と `limit` (1 から 100、初期値 50)
- ルートの処理の順とルートだけの失敗は、`v1.yaml` の各ルートの `x-steps` と `x-errors` (description にも同じ中身) に従う。処理を変えたら v1.yaml を先に直し、同じ道具で 2-routes.md を作り直す
- WAF が無いので 1-api.md の 3.6 の守りを外さない。入力は Zod の `strict()`、JWT は決めた `alg` だけ、署名の比べは `timingSafeEqual`、外への `fetch` は `allowedFetch` だけ、WebSocket の切り替えは `Origin` を確かめる。Access を外すパスを `/hooks/v1/github` のほかに足さない
