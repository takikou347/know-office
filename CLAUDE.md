# know-office

AI 社員を管理するアプリ。組織の決まりは takikou347/knowidea の CLAUDE.md。

## 作り方

- このリポジトリにはコードとテストだけを置く。要件とシナリオと設計書は非公開の takikou347/knowidea の services/know-office/ に、進み具合は GitHub Issues だけに置く
- 作る物は docs/04-detail/ の詳細設計に従う。要件は詳細設計の機能ごとの文書の 1 章、シナリオとテストの置き場は docs/05-test/ の同じ番号の文書にある。API の形は Swagger UI (`apps/office/openapi/v1.yaml`) を読む。書き方は .claude/rules/ (触るファイルに合う物が読み込まれる。正本はこの rules) に従う。形が変わったら、設計書は同じ時に knowidea の PR で直す
- Issue 1 件はスキル `build-scene` で、要件のシナリオごとに落ちるテストから作る (Issue の立て方と入れ方は knowidea のスキル `issue`)。済みは、シナリオが入口から画面までつながって動く事 (`apps/office/e2e/flows/` の通し)。サーバーの側だけでは Issue を閉じない。デプロイの前は `RELEASE=1 pnpm verify --e2e` を通す
- 画面のコンポーネントは knowidea-ui を使う。足りない物は knowidea-ui に足してバージョンを上げてから入れる

## 直し方

- main で直さず、ブランチで直して PR にし、作った者と別のモデルのレビュー担当(.claude/agents の reviewer か reviewer-alt)が承認を出したら、そのブランチを main へ fast-forward で push して入れる。main が進んでいたら rebase し、チェックを通し直す。GitHub の画面や API では入れない
- push の前に `pnpm verify` を通す。lint、typecheck、test (テスト設計 4-guard のシナリオとテストの名前の照合を含む。knowidea の無い CI では飛ばす)、build、knowidea の check.py をまとめて走らせ、落ちた所だけを出す。画面を変えたら `pnpm verify --e2e`
- 要件の残りとこの後のタスクは GitHub Issues に 1 つ 1 件で置く。area のラベルは `frontend`、`backend`、`agent`、`infra`、`ci`

## 書き方

- 公開リポジトリなので、作者も入れた者も `KNOW IDEA <noreply@knowidea.invalid>`。オーナーのメールアドレスを残さず、名前(GitHub のログイン名)は URL、LICENSE、チェックの LEGACY に挙げた 2 件のコミットにだけ残す。コミットと PR に AI の署名や帰属の行を付けない
