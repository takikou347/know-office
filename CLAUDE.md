# know-office

AI 社員を管理するアプリ。組織の決まりは takikou347/knowidea の CLAUDE.md。

## 作り方

- 仕様は OpenSpec(openspec/)。変更は openspec/changes/<名前>/ に提案、設計、タスクを書き、テストを先に書いて 1 場面ずつ作る
- 終わった変更は specs に移してから、changes/<名前>/ を消す。archive は使わない(日付の付いたフォルダが溜まるため)
- 画面の部品は knowidea-ui を使う。足りない物は knowidea-ui に足して版を上げてから入れる

## 直し方

- main を直に触らず、ブランチで直して PR にし、作った者と別のモデルの見る役が可を出してから入れる
- push の前に、テストと `npx @fission-ai/openspec@1.16.0 validate --all --strict` と `python3 knowidea/tools/check.py know-office` を通す
- 要件の残りとこの後の仕事は GitHub Issues に 1 つ 1 件で置く

## 書き方

- 公開リポジトリなので、作者は `KNOW IDEA (<モデル>)`、メールは `noreply@knowidea.invalid`
- コミットと PR に AI の署名や帰属の行を付けない
