---
paths:
  - "**/test/**"
  - "**/e2e/**"
  - "**/*.test.{ts,tsx}"
  - "**/*.types.ts"
---

# テストの書き方

正本は knowidea の `../knowidea/services/know-office/docs/05-conventions.md` の 4 章。

- テストは作る前に書き、思った理由で落ちる事を確かめてから作る。誤字とバグの直しも同じ
- うまくいく道と一緒に、同時の更新 (2 つが同じ版を読む)、二重の決定、途中で落ちた時に何も残らない事、境目の値 (上限ちょうど、形の違う入力) のテストを先に書く。順に呼ぶだけのテストは同時を確かめない。書く直前に別の変更を挟むには、テストの env の `DB.batch` や `FILES.put` を包む
- 最初から通る守りのテストは、作った所を壊して落ちる事を確かめてから残す
- 要件のシナリオのテストは、`describe` を要件の名前、`it` をシナリオの名前と同じ日本語にする。対応は詳細設計の機能ごとの文書の 4 章
- 1 つのシナリオを多くの画面や入力で回し、1 つの `it` では 5 秒を超える時は、`describe` をシナリオの名前にして、その中の `it` を画面や入力の名前にする
- 置き場: 共通 `packages/core/test/<物>.test.ts`、ゲートウェイと DO `apps/office/test/<まとまり>/<物>.test.ts`、画面の通し `apps/office/e2e/<画面か流れ>.spec.ts`、ワークスペース `apps/workspace/test/<物>.test.ts`、型の食い違い `<物>.types.ts` に `@ts-expect-error`、リポジトリの道具 `scripts/<物>.test.ts` (`node:test`)
- モックは境目だけ。D1 は `test/helpers/d1.ts` (wrangler の手元の本物の D1)、DO は `test/helpers/worker.ts` (本物の workerd に起こしたテストの入口)、時刻は `Clock` のモック、Claude と GitHub は記録した返事を返すモック
- テストは互いに独立させ、1 つ 5 秒以内
- 画面の通しは Chrome と Safari、幅 360、1,024、1,280 で、axe の critical と serious を 0 にする
- 走らせる時は 1 ファイルずつ (`pnpm --filter <パッケージ> exec vitest run <ファイル>`)。全部は push の前の `pnpm verify` で
- 「済み」は、要件のシナリオが入口 (画面の操作、Cron、通知、社員のツール) から画面に出るまで、代わりの Claude と GitHub と Access の上でつながって動く事。単体のテストが通るだけでは済みにしない。つながりは `apps/office/e2e/flows/<利用場面>.spec.ts` で確かめ、ここではゲートウェイの返事を差し替えない (`page.route`、`context.route`、HAR、`addInitScript` での `fetch` の差し替えのどれも)
- 画面は `src/screen/mock.ts` を読まない。v1.yaml のルートは全部作る。残っている物は `test/screen/no-mock.test.ts` の `STILL_MOCK` と `test/gate/openapi.test.ts` の `UNBUILT` に Issue の番号と並べ、作ったら消す。足さない。`mock.ts` を再 export する中継のファイルを作らない
- 代わりの Claude と GitHub は、本物が断る物 (違う鍵、User-Agent の無い要求、上限) を同じように断る。本物の返事を記録した見本があれば、同じ Zod の形に両方を通す
