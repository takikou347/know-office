# know-office

AI 社員を管理するアプリ。組織の決まりは takikou347/knowidea の CLAUDE.md。

## 作り方

- 仕様は OpenSpec(openspec/)。始め方と終え方はスキル `spec-change`(archive と design.md は使わない)
- 設計書は非公開の takikou347/knowidea の services/know-office/ に置く。作る物は docs/04-detail/ の詳細設計に従う。書き方は .claude/rules/ (触るファイルに合う物が読み込まれる。正本は docs/05-conventions.md) に従う。形が変わったら、仕様はコードと同じ PR で、設計書は同じ時に knowidea の PR で直す
- tasks.md の 1 項目はスキル `build-scene` で、要件のシナリオごとに落ちるテストから作る
- 画面のコンポーネントは knowidea-ui を使う。足りない物は knowidea-ui に足してバージョンを上げてから入れる

## 直し方

- main で直さず、ブランチで直して PR にし、作った者と別のモデルのレビュー担当(.claude/agents の reviewer か reviewer-alt)が承認を出したら、そのブランチを main へ fast-forward で push して入れる。main が進んでいたら rebase し、チェックを通し直す。GitHub の画面や API では入れない
- push の前に `pnpm verify` を通す。lint、typecheck、test、build、OpenSpec の validate、knowidea の check.py をまとめて走らせ、落ちた所だけを出す。画面を変えたら `pnpm verify --e2e`
- 要件の残りとこの後のタスクは GitHub Issues に 1 つ 1 件で置く

## 書き方

- 公開リポジトリなので、作者も入れた者も `KNOW IDEA <noreply@knowidea.invalid>`。オーナーのメールアドレスを残さず、名前(GitHub のログイン名)は URL、LICENSE、チェックの LEGACY に挙げた 2 件のコミットにだけ残す。コミットと PR に AI の署名や帰属の行を付けない
