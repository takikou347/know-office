---
paths:
  - "**/*.{ts,tsx}"
---

# コードの書き方

正本は knowidea の `../knowidea/services/know-office/docs/05-conventions.md` の 1 章から 3 章。ここにはチェックで落ちない決まりだけを置く。lint で落ちる決まりは、書いたファイルをフックがその場で lint して返すので、返った所を直す。

## 名前と置き場

- 置き場は `../knowidea/services/know-office/docs/04-detail.md` の 2 章。ゲートウェイ `apps/office/src/gate/`、画面 `apps/office/src/screen/`、ワークスペース `apps/workspace/src/`、共通 `packages/core/src/`
- 関数と変数は lowerCamelCase、型とコンポーネントは PascalCase、決まった値の並びは UPPER_SNAKE_CASE
- テーブルとカラムは snake_case。時刻は `<動き>_at` (協定世界時のミリ秒)、日本時間の日は `day`
- Zod スキーマは `<動き><物>Input`、返す形の型は物の名前 (`CreateNodeInput`、`NodeDetail`)
- 名前は英語、コメントとテストの名前は日本語

## 型と境目

- 外から来る物 (画面の入力、GitHub の通知、ワークスペースからの要求、Claude のツールの入力、D1 の JSON のカラム、R2 から読んだ物) は `unknown` で受け、`packages/core/src/schemas/<物>.ts` の Zod スキーマで確かめてから使う
- 行の型は Drizzle の `$inferSelect` と `$inferInsert`、入力の型は `z.infer` から取り、手で書き写さない
- 種類は文字列の合わせと `as const` の並びで書き、`enum` を使わない
- 秘密と鍵は `Secret` で持ち、記録と返事に出さない
- ID は `core` の `newId()` (UUID v7)、日本時間への直しは `jstDay(at)` と `jstClock(at)` だけ

## 書き方

- 否定は早く返すガード (`if (!session) throw ...`) と、否定の側にしか処理の無い所だけに使う
- 想定した失敗は `core` の `AppError(code, message)` を投げる。想定外は `internal` にし、中身は `log` と `audit_log` にだけ残す。オーナーの情報、鍵、作業トークンを記録の文に入れない
- セキュリティに関わる判断は、届かない、遅い、形が違う時は断る側に倒す
- 今の時刻は引数で受けた `Clock` の `now()` を使い、`Date.now()` を直に呼ばない
- 外を呼ぶ時は `AbortSignal.timeout()` を付ける。初期値は 10 秒、ルールの判断は 5 秒
- D1 にまとめて書く時は `db.batch()`、`audit_log` は記録 DO を通す

## コメント

- ファイルの頭に、受け持ちを `//` で 1 行
- 外に出す関数、型、定数、Zod スキーマ、DO のメソッドに JSDoc。1 行目は何をするかを 1 文、`@param` と `@returns` に説明、`AppError` を投げるなら `@throws` に `code` と投げる時。型は書かない
- React のコンポーネントは props の型の項目ごとに JSDoc
- `//` は「なぜ」と前提だけ。外の決まりに合わせた所は出典 (`// RFC 9457 の 3.1`)。日本語の常体で結論から
- `TODO` は `// TODO(#<Issue の番号>): <する事>` だけ。コメントアウトしたコードを残さない

## 依存

- バージョンを固定し (`^` を付けない)、`pnpm-lock.yaml` を一緒にコミットする
- Workers と Node の両方か使う側で動き、保守されている物だけ。画面の部品は knowidea-ui を先に探す
