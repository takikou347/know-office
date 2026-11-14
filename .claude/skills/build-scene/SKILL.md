---
name: build-scene
description: know-office の tasks.md の 1 項目を、要件の場面ごとに落ちるテストから作り、main に入れるまでの手順
---

1. 読む: この CLAUDE.md、knowidea の `services/know-office/docs/conventions.md`、作る段の `services/know-office/docs/detail/<番号>-<名前>.md`、その段が指す `openspec/changes/<名前>/specs/` の要件
2. 枝を切る。名前は中身の分かる英語 (例: `stage1-access-login`)。1 つの枝に 1 つのタスクの番号
3. 要件の場面を 1 つ選び、詳細設計の 4 章「試験」が指す置き場に、場面の名前をそのまま `it()` の名前にした試験を書く。走らせて、思った理由で落ちる事を確かめる
4. 詳細設計の 1 章から 3 章の受け口、データの形、動きのとおりに作り、その試験を通す。場面が残っていれば 3 に戻る
5. 詳細設計と違う形にした時は、同じ時に knowidea の詳細設計を直す枝を切る。要件が変わる時は、この枝で `openspec/` も直す
6. 通す: `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、画面を変えたら `pnpm e2e`、`npx @fission-ai/openspec@1.16.0 validate --all --strict`、`python3 knowidea/tools/check.py know-office`
7. tasks.md の項目に印を付け、作った者と別のモデルの見る役 (作ったのが Opus なら `reviewer-alt`、Sonnet なら `reviewer`) に差分を見せる。不可なら直して 6 に戻る
8. push して PR を出し、CI が通ったら、その枝を main へ fast-forward で push する
