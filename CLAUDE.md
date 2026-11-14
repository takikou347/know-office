# know-office

AI 社員を管理するアプリ。組織の決まりは takikou347/knowidea の CLAUDE.md。

## 作り方

- 仕様(OpenSpec)と設計書は公開しないので、非公開の takikou347/knowidea の know-office/ に置く。全量は know-office/docs/README.md、決まりも同じ所にある
- テストを先に書いて 1 場面ずつ作る。形が変わったら、コードの PR と同じ時に knowidea の PR で仕様と設計書を直す
- 画面の部品は knowidea-ui を使う。足りない物は knowidea-ui に足して版を上げてから入れる

## 直し方

- main で直さず、枝で直して PR にし、作った者と別のモデルの見る役が可を出したら、その枝を main へ fast-forward で push して入れる。main が進んでいたら rebase し、検査を通し直す。GitHub の画面や API では入れない
- push の前に、テストと `python3 knowidea/tools/check.py know-office` を通す
- 要件の残りとこの後の仕事は GitHub Issues に 1 つ 1 件で置く

## 書き方

- 公開リポジトリなので、作者も入れた者も `KNOW IDEA <noreply@knowidea.invalid>`。オーナーのメールアドレスを残さず、名前(GitHub のログイン名)は URL、LICENSE、検査の LEGACY に挙げた 2 件のコミットにだけ残す
- コミットと PR に AI の署名や帰属の行を付けない
