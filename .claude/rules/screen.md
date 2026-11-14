---
paths:
  - "apps/office/src/screen/**"
  - "apps/office/e2e/**"
---

# 画面の書き方

正本は knowidea の `../knowidea/services/know-office/docs/04-detail.md` と、作る画面の機能ごとの文書。

- 部品は knowidea-ui (`knowidea-ui`、`knowidea-css`、`knowidea-icons`、`knowidea-tokens`) を使う。足りない物は knowidea-ui に足し、バージョンを上げてから入れる。色と余白は直に書かずトークンを使う
- 画面ごとに `pages/<画面>/`、共通は `parts/`
- データはゲートウェイの型を Hono の RPC で受ける。テーブル、DO、Drizzle を読まない
- 返事は `code` で分け、`title` と `detail` の文で分けない。不具合を伝える時は `traceId` を出す
- 知らせはメールでなく画面に出す
- WCAG 2.2 AA。画面を変えたら `pnpm verify --e2e` を通す
