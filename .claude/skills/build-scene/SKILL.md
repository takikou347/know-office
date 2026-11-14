---
name: build-scene
description: know-office の tasks.md の 1 項目を、要件のシナリオごとに落ちるテストから作り、main にマージするまでの手順
---

1. 読む: この CLAUDE.md、knowidea の `services/know-office/docs/05-conventions.md`、作るフェーズの `services/know-office/docs/04-detail/<番号>-<名前>.md`、そのフェーズが指す `openspec/changes/<名前>/specs/` の要件
2. ブランチを切る。名前は中身の分かる英語 (例: `stage1-access-login`)。1 つのブランチに 1 つのタスク ID
3. 要件のシナリオを 1 つ選び、詳細設計の 4 章「テスト」が指す置き場に、シナリオの名前をそのまま `it()` の名前にしたテストを書く。走らせて、思った理由で落ちる事を確かめる
4. 詳細設計の 1 章から 3 章のインターフェース、データの形、動きのとおりに作り、そのテストを通す。シナリオが残っていれば 3 に戻る
5. 詳細設計と違う形にした時は、同じ時に knowidea の詳細設計を直すブランチを切る。要件が変わる時は、このブランチで `openspec/` も直す
6. 通す: `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、画面を変えたら `pnpm e2e`、`npx @fission-ai/openspec@1.16.0 validate --all --strict`、`python3 knowidea/tools/check.py know-office`
7. tasks.md の項目に印を付け、作った者と別のモデルのレビュー担当 (作ったのが Opus なら `reviewer-alt`、Sonnet なら `reviewer`) に差分を見せる。差し戻しなら直して 6 に戻る
8. push して PR を出し、CI が通ったら、そのブランチを main へ fast-forward で push する
