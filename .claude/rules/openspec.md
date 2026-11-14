---
paths:
  - "openspec/**"
---

# 要件 (OpenSpec) の書き方

手順はスキル `spec-change`。書き方の決まりは `openspec/config.yaml` の rules にもある。

- changes の下には `proposal.md`、`specs/`、`tasks.md` だけを置く。`design.md` を作らず、設計は knowidea の `../knowidea/services/know-office/docs/04-detail/` に書く
- `openspec archive` を使わない。終える時は仕様を `openspec/specs/` に移し、`changes/<名前>/` を消す
- シナリオはそのままテストの名前になる。数、時刻、上限を具体的に書く
- 作らない物、選ばなかった案は書かない。お金が増える事か外部連携に当たる時はそう書く
- 確かめは `npx @fission-ai/openspec@1.16.0 validate --all --strict`
