# know-office

AI 社員を管理するアプリ。組織の決まりは takikou347/knowidea の CLAUDE.md。

## 作り方

- 仕様は OpenSpec(openspec/)。始め方と終え方はスキル `spec-change`(archive と design.md は使わない)
- 設計書は非公開の takikou347/knowidea の services/know-office/ に置く。作る物は docs/detail/ の詳細設計、書き方は docs/conventions.md のコード規約に従う。形が変わったら、仕様はコードと同じ PR で、設計書は同じ時に knowidea の PR で直す
- tasks.md の 1 項目はスキル `build-scene` で、要件の場面ごとに落ちるテストから作る
- 画面の部品は knowidea-ui を使う。足りない物は knowidea-ui に足して版を上げてから入れる

## 直し方

- main で直さず、枝で直して PR にし、作った者と別のモデルの見る役(.claude/agents の reviewer か reviewer-alt)が可を出したら、その枝を main へ fast-forward で push して入れる。main が進んでいたら rebase し、検査を通し直す。GitHub の画面や API では入れない
- push の前に `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`npx @fission-ai/openspec@1.16.0 validate --all --strict`、`python3 knowidea/tools/check.py know-office` を通す
- 要件の残りとこの後の仕事は GitHub Issues に 1 つ 1 件で置く

## 書き方

- 公開リポジトリなので、作者も入れた者も `KNOW IDEA <noreply@knowidea.invalid>`。オーナーのメールアドレスを残さず、名前(GitHub のログイン名)は URL、LICENSE、検査の LEGACY に挙げた 2 件のコミットにだけ残す。コミットと PR に AI の署名や帰属の行を付けない
