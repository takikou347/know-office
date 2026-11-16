---
paths:
  - "**/test/**"
  - "**/e2e/**"
  - "**/*.test.{ts,tsx}"
  - "**/*.types.ts"
---

# テストの書き方

正本はこの rules。層と走らせ方は knowidea の `../knowidea/services/know-office/docs/05-test/index.md`。

- テストは作る前に書き、思った理由で落ちる事を確かめてから作る。誤字とバグの直しも同じ
- うまくいく道と一緒に、同時の更新 (2 つが同じ版を読む)、二重の決定、途中で落ちた時に何も残らない事、境目の値 (上限ちょうど、形の違う入力) のテストを先に書く。順に呼ぶだけのテストは同時を確かめない。書く直前に別の変更を挟むには、テストの env の `DB.batch` や `FILES.put` を包む
- 最初から通る守りのテストは、作った所を壊して落ちる事を確かめてから残す
- 要件のシナリオのテストは、`describe` を要件の名前、`it` をシナリオの名前と同じ日本語にする。要件とシナリオと置き場は、テスト設計 (`docs/05-test/<番号>-<名前>.md`) の 1 章と 2 章。`node scripts/scenarios.ts` が名前の合うテストを探す
- 1 つのシナリオを多くの画面や入力で回し、1 つの `it` では 5 秒を超える時は、`describe` をシナリオの名前にして、その中の `it` を画面や入力の名前にする
- 置き場: 共通 `packages/core/test/<物>.test.ts`、ゲートウェイと DO `apps/office/test/<まとまり>/<物>.test.ts`、画面の通し `apps/office/e2e/<画面か流れ>.spec.ts`、ワークスペース `apps/workspace/test/<物>.test.ts`、型の食い違い `<物>.types.ts` に `@ts-expect-error`、リポジトリの道具 `scripts/<物>.test.ts` (`node:test`)
- モックは境目だけ。D1 は `test/helpers/d1.ts` (wrangler の手元の本物の D1)、DO は `test/helpers/worker.ts` (本物の workerd に起こしたテストの入口)、時刻は `Clock` のモック、Claude と GitHub は記録した返事を返すモック
- 並んで走る処理の順や長さを、実の時間の待ち (`setTimeout`) と共にある `Clock` の進みで作らない。ほかの処理が遅いと揺れるので、長さを測る口か合図を引数で渡して決める
- テストは互いに独立させ、1 つ 5 秒以内。D1 と DO はテストのファイルごとに 1 度起こし、テストごとに戻す (D1 はマイグレーションの後の空、DO は空)
- e2e のポートは作業ツリーの道から決まる `E2E_PORT` で、代わりの Claude と GitHub はその 1 つ上を使う。ほかの作業ツリーと重なれば起こす時に落ちる
- 画面の通しは Chrome の幅 1,280 で全部、幅 360 で形の変わる画面 (a11y、screens、review、office) を流し、axe の critical と serious を 0 にする。Safari はデプロイの前に Mac で `E2E_BROWSERS=safari` を付けて 1 度流す
- 走らせる時は 1 ファイルずつ (`pnpm --filter <パッケージ> exec vitest run <ファイル>`、e2e は `pnpm --filter @know-office/office exec playwright test <ファイル>`)。全部は push の前の `pnpm verify` で 1 回だけ
- 「済み」は、要件のシナリオが入口 (画面の操作、Cron、通知、社員のツール) から画面に出るまで、代わりの Claude と GitHub と Access の上でつながって動く事。単体のテストが通るだけでは済みにしない。つながりは `apps/office/e2e/flows/<利用場面>.spec.ts` で確かめ、ここではゲートウェイの返事を差し替えない (`page.route`、`context.route`、HAR、`addInitScript` での `fetch` の差し替えのどれも)
- 画面は `src/screen/mock.ts` を読まない。v1.yaml のルートは全部作る。残っている物は `test/screen/no-mock.test.ts` の `STILL_MOCK` と `src/gate/routes/planned.ts` の `PLANNED_ROUTES` に Issue の番号と並べ、作ったら消す。足さない。`mock.ts` を再 export する中継のファイルを作らない
- 代わりの Claude と GitHub は、本物が断る物 (違う鍵、User-Agent の無い要求、上限) を同じように断る。本物の返事を記録した見本があれば、同じ Zod の形に両方を通す
- 利用場面の通し (`apps/office/e2e/flows/<利用場面>.spec.ts`) は Playwright の `flows` のプロジェクトで、Chrome の幅 1,280 で 1 本ずつ、ほかの通しの後に流れる。本物の D1 と DO を書き換えるので、前の通しが残した値に頼らず、終わる時に元の値へ戻す
- パスキーの確認が要る操作は、テストの頭で `useOwnerPasskey(page)` (`e2e/flows/helpers/passkey.ts`) を呼ぶ。`flows/passkey.setup.ts` が設定の画面で登録した 1 本が仮想の認証器に入り、画面が求めた時に自動で確かめる
- 画面から作れない前提 (社員が出した承認など) は `seedMain(sql)` (`e2e/flows/helpers/seed.ts`) で手元の D1 に置き、画面の部分は `part(page, "<h2 の見出し>")` (`e2e/flows/helpers/screen.ts`) で探す
