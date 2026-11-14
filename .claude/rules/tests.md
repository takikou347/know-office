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
- 要件のシナリオのテストは、`describe` を要件の名前、`it` をシナリオの名前と同じ日本語にする。対応は詳細設計の機能ごとの文書の 4 章
- 置き場: 共通 `packages/core/test/<物>.test.ts`、ゲートウェイと DO `apps/office/test/<まとまり>/<物>.test.ts`、画面の通し `apps/office/e2e/<画面か流れ>.spec.ts`、ワークスペース `apps/workspace/test/<物>.test.ts`、型の食い違い `<物>.types.ts` に `@ts-expect-error`、リポジトリの道具 `scripts/<物>.test.ts` (`node:test`)
- モックは境目だけ。D1 は miniflare の本物、DO は `runInDurableObject`、時刻は `Clock` のモック、Claude と GitHub は記録した返事を返すモック
- テストは互いに独立させ、1 つ 5 秒以内
- 画面の通しは Chrome と Safari、幅 360、1,024、1,280 で、axe の critical と serious を 0 にする
- 走らせる時は 1 ファイルずつ (`pnpm --filter <パッケージ> exec vitest run <ファイル>`)。全部は push の前の `pnpm verify` で
