---
name: build-scene
description: know-office の tasks.md の 1 項目を、要件のシナリオごとに落ちるテストから作り、main にマージするまでの手順
---

1. 読む: 作る機能の knowidea の `services/know-office/docs/04-detail/<番号>-<名前>.md` と、その文書が指す `openspec/changes/<名前>/specs/` の要件。`04-detail/2-routes.md` と `3-data.md` は全文を読まず、使うルートとテーブルの行を grep で引く。書き方の決まりは、触るファイルに合う `.claude/rules/` が読み込まれるので、05-conventions.md を読み直さない
2. ブランチを切る。名前は中身の分かる英語 (例: `access-login`)。1 つのブランチに 1 つのタスク ID
3. 要件のシナリオを 1 つ選び、詳細設計の 4 章「テスト」が指す置き場に、シナリオの名前をそのまま `it()` の名前にしたテストを書く。走らせて、思った理由で落ちる事を確かめる
4. ルートを足す、変える時は、先に `apps/office/openapi/v1.yaml` を直す。詳細設計の 1 章から 3 章のインターフェース、データの形、動きと、`v1.yaml` の形のとおりに作り、そのテストを通す。シナリオが残っていれば 3 に戻る
5. 詳細設計か `v1.yaml` と違う形にした時は、同じ時に knowidea の詳細設計を直すブランチを切る。要件が変わる時は、このブランチで `openspec/` も直す
6. 通す: `pnpm verify` (画面を変えたら `pnpm verify --e2e`)。落ちた手順は出力の最後だけが出るので、直したらそのファイルだけを走らせ直し (`pnpm --filter <パッケージ> exec vitest run <ファイル>`)、最後にもう一度 `pnpm verify`
7. tasks.md の項目に印を付け、作った者と別のモデルのレビュー担当 (作ったのが Opus なら `reviewer-alt`、Sonnet なら `reviewer`) に差分を見せる。差し戻しなら直して 6 に戻る
8. push して PR を出し、CI が通ったら、そのブランチを main へ fast-forward で push する
