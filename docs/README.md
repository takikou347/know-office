# 設計書の全量

設計書は 4 段に分かれる。要件定義、基本設計、画面設計はそろっている。詳細設計は作る段ごとに、作る直前に書く。

| 段 | 文書 | 今の状態 |
| --- | --- | --- |
| 要件定義 (何ができるか) | [openspec/changes/build-office/specs/](../openspec/changes/build-office/specs/) の 10 の文書 (画面、勤務、止める、仕事の回し方、レビュー、サービス、GitHub、守り、見張り、拡張)。各要件に場面が付き、そのまま試験になる。なぜ作るかは [proposal.md](../openspec/changes/build-office/proposal.md) | そろった |
| 基本設計 (どう作るか) | [architecture.md](architecture.md) (全体の形、社員の 1 日、守り、記録の置き場、作る順) と [stack.md](stack.md) (インフラ、言語、型安全、公開) | そろった |
| 画面設計 (どう見えるか) | [画面の要件](../openspec/changes/build-office/specs/screens/spec.md) と、仮のデータで動くモック ([apps/office](../apps/office/)) | そろった |
| 詳細設計 (何をどう書くか) | [design.md](../openspec/changes/build-office/design.md) に段ごとの節を足す。正本はコードの型、Zod の形、Drizzle の表、テスト | 作る順 1 (土台) の前に書く |

作る順と残りの仕事は [tasks.md](../openspec/changes/build-office/tasks.md)、要件の残りは GitHub の Issue にある。

## 設計が変わる時の回し方

- 詳細設計は先にまとめて書かず、段ごとに作る直前に書く。先に書くと作る時に古くなる
- 作っていて設計と違う形になったら、コードと同じ PR で要件と設計の文書も直す。`openspec validate` が要件の形を確かめる
- 詳細の正本はコードの型と D1 の作り替えとテストに置き、文書には決めた理由と表の形だけを書く
- 段が終わったら、残すべき決めを architecture.md に移す。変更を specs に移す時に design.md は消える
- OpenSpec が扱うのは要件 (specs) と変更 (changes) だけで、長く残る設計を docs/ に置くのは OpenSpec の決まりに反しない
