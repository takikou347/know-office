# know-office

AI 社員を管理するアプリ。組織の決まりは takikou347/knowidea の CLAUDE.md。

## 作り方

- 仕様は OpenSpec(openspec/)。変更は openspec/changes/<名前>/ に提案、設計、タスクを書き、テストを先に書いて 1 場面ずつ作る。詳細設計は段ごとに作る直前に書き(正本は型、D1 の作り替え、テスト)、作って形が変わったらコードと同じ PR で specs と design.md を直す
- 終わった変更は specs に移してから、changes/<名前>/ を消す。archive は使わない(日付の付いたフォルダが溜まるため)
- 画面の部品は knowidea-ui を使う。足りない物は knowidea-ui に足して版を上げてから入れる

## 直し方

- main で直さず、枝で直して PR にし、作った者と別のモデルの見る役が可を出したら、その枝を main へ fast-forward で push して入れる。main が進んでいたら rebase し、検査を通し直す。GitHub の画面や API では入れない
- push の前に、テストと `npx @fission-ai/openspec@1.16.0 validate --all --strict` と `python3 knowidea/tools/check.py know-office` を通す
- 要件の残りとこの後の仕事は GitHub Issues に 1 つ 1 件で置く

## 書き方

- 公開リポジトリなので、作者も入れた者も `KNOW IDEA <noreply@knowidea.invalid>`。オーナーのメールアドレスを残さず、名前(GitHub のログイン名)は URL、LICENSE、検査の LEGACY に挙げた 2 件のコミットにだけ残す
- コミットと PR に AI の署名や帰属の行を付けない
