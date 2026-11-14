---
name: spec-change
description: know-office の要件 (OpenSpec) の変更を始める、直す、終える手順。標準の OpenSpec の流れとの違いもここに従う
---

標準の OpenSpec と違う所は 3 つ。

- 設計は `design.md` に書かず、非公開の knowidea の `services/know-office/docs/` に書く。changes の下には `proposal.md`、`specs/`、`tasks.md` だけを置く
- 終える時に `openspec archive` を使わない。仕様を `openspec/specs/` に移し、`openspec/changes/<名前>/` を消す。日付の付いたフォルダを残さない
- OpenSpec の Claude 向けのスキルと命令 (`openspec init --tools claude` が作る物) は入れない。この手順と `build-scene` が代わる

始める:

1. `npx @fission-ai/openspec@1.16.0 new change <名前>` で枠を作る。名前は英語の小文字とハイフン
2. `proposal.md` は結論から、作る物と実現する事を書く。お金が増える事か外部連携に当たる時はそう書き、オーナーの はい を得てから進める
3. `specs/<能力>/spec.md` に要件とシナリオを書く。シナリオはそのままテストの名前になるので、数と時刻を具体的に書く
4. `tasks.md` は、落ちるテストを書くタスクを作るタスクの前に置く
5. 同じ時に knowidea の詳細設計にフェーズか章を足し、4 章「テスト」にシナリオとテストの置き場を並べる
6. `npx @fission-ai/openspec@1.16.0 validate --all --strict` を通す

終える (tasks.md が全部済んだ時):

1. `openspec/changes/<名前>/specs/<能力>/spec.md` の要件を `openspec/specs/<能力>/spec.md` に移す。ADDED は足し、MODIFIED は置き換え、REMOVED は消す
2. `openspec/changes/<名前>/` を消し、validate を通す
3. knowidea の詳細設計の要件へのリンクを `openspec/specs/` に向け直す
