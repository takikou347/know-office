---
name: build-scene
description: know-office の GitHub Issue 1 件を、要件のシナリオごとに落ちるテストから作り、1 ブランチと 1 PR で main に入れるまでの手順。Issue の立て方と入れ方の共通の決まりは knowidea のスキル issue
---

1. 読む: Issue の本文と、本文が指す knowidea の `services/know-office/docs/04-detail/<番号>-<名前>.md` (要件と作る物と動き) と、同じ番号の `05-test/<番号>-<名前>.md` (テストの置き場とシナリオ)。ルートは `apps/office/openapi/v1.yaml` (Swagger UI)、テーブルは `apps/office/src/gate/db/` のスキーマを、使う所だけ grep で引く。書き方の決まりは、触るファイルに合う `.claude/rules/` が読み込まれる
   - 新しい機能 (ルート、テーブル、画面を足す) は、作る前に計画を作り、作った者と別のモデルのレビュー担当に「計画のレビュー」として見せ、通ってから作る。直しと小さな変更は計画のレビューを飛ばす。並列の時は渡す側が計画を作って通し、作業者に渡す
   - 計画に入れる物: 詳細設計の直し案 (差分か要点。knowidea のブランチで直したなら、それも見せる)、足す `it()` の名前の一覧、書く所ごとの条件 (1 文かバッチか)、外を呼ぶ所 (相手の API の上限、再送で二重にならない形)、費用が出る所 (初期値 off の設定)、定期の確かめで処理を止める所の誤検知の隙 (変更の途中、同時)
2. ブランチを切る (名前は knowidea のスキル `land` の 1)。1 つのブランチに 1 つの Issue。1 つの PR で入らない大きさなら、先に子の Issue に分ける
3. 要件のシナリオを 1 つ選び、テスト設計の 1 章が指す置き場に、要件の名前を `describe()`、シナリオの名前をそのまま `it()` の名前にしたテストを書く。走らせて、思った理由で落ちる事を確かめ、落ちた出力の要点を控える (8 でレビュー担当に添える)
4. ルートを足す、変える時は、先に `createRoute` (説明、`x-steps`、`x-errors` を含む) と `core` の Zod スキーマを書き、`pnpm --filter @know-office/office openapi` で `apps/office/openapi/v1.yaml` を作り直す。詳細設計の 2 章と 3 章の作る物と動きのとおりに作り、そのテストを通す。シナリオが残っていれば 3 に戻る
5. 作った後に、計画で決めた詳細設計と違う形になった時や、`v1.yaml` のルートの一覧が変わった時は、同じ時に knowidea の詳細設計を直すブランチを切る。要件が変わる時は、同じ knowidea のブランチで詳細設計の要件とテスト設計のシナリオも直し、PR の本文に Issue の URL を書く。`node scripts/scenarios.ts <文書の名前>` でシナリオとテストの名前が合うかを確かめる
6. 通す: `pnpm verify` (画面を変えたら `pnpm verify --e2e`)。作業ツリーごとに e2e のポートが違うので、ほかの作業ツリーと同時に流してよい。落ちた手順は出力の最後だけが出るので、直したらそのファイルだけを走らせ直し (vitest は `pnpm --filter <パッケージ> exec vitest run <ファイル>`、e2e は `pnpm --filter @know-office/office exec playwright test <ファイル>`)、最後にもう一度 `pnpm verify`。全部を流すのは最後の 1 回だけ
7. Issue を閉じてよい (PR の本文に `Closes #<番号>` を書いてよい) のは、その Issue の要件のシナリオが `apps/office/e2e/flows/` の通しで、画面からつながって動いた時だけ。サーバーの側だけ作った時は `Refs #<番号>` にして閉じず、残りを Issue に書き足す。作る途中で見つけた別の課題は同じ PR に入れず、新しい Issue を立てる。`PLANNED_ROUTES` (`src/gate/routes/planned.ts`) と `STILL_MOCK` (`.claude/rules/tests.md`) から、作った物を消す
8. レビューの前に、`.claude/rules/api.md` と `tests.md` のうち、よく差し戻される物 (書く条件と一緒に書く出来事を 1 文かバッチに入れる、`x-step-up`、外から来た ID とキーと道の形、前の作業トークンの失効、同時と二重と境目と分岐ごとのテスト、外への送信の二重、費用の出口、設計書の直し) を差分に当てて自分で確かめる。レビューは knowidea のスキル `review` で頼み、3 で控えた落ちた理由を添える
9. PR の題は Issue と同じ中身にする。出し方と main への入れ方は knowidea のスキル `land`。PR は先に下書きで出し、CI をレビューと同時に回す。本文の `Closes` と `Refs` は 7 で決める

## 並列で進める時

- 親 Issue ごとのスレッドや worktree の作業者に分ける時は、knowidea のスキル `parallel` に従う。e2e のポートは作業ツリーごとに違うので、verify はほかの作業ツリーと同時に流してよい

## 区切りごとの監査

- 親の Issue が 1 つ閉じるごとと、デプロイの前に、作った者と別のモデルで (Agent の `model` で指定する) エージェント `auditor` に要件の全シナリオを入口から画面まで追わせる。diff のレビューでは全体の抜けは見つからない
- オーナーへの「終わった」の報告は、閉じた Issue の数でなく、`RELEASE=1 pnpm verify --e2e` (`UNBUILT` と `STILL_MOCK` が空で、利用場面の通しが全部通る) と、開いている Issue が本物の環境待ちだけである事で言う
