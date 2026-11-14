# know-office のインフラと技術

[architecture.md](architecture.md) の形を何で作るか。

## インフラの対応表

案 B に変えた後も、インフラはほとんどそのまま合う。合わないのは知らせのメールで、条件が付くのは試験用の環境である。

| 部分 | 使う物 | 合っているか |
| --- | --- | --- |
| 画面と API (入口) | Workers (Hono)。画面は同じ Worker から配る | 合う。画面は作った物を配るだけで、API は Claude と GitHub の返事を待つ時間が主なので、Workers の CPU の上限に当たらない |
| ログイン | Cloudflare Access (Google) とパスキー | 合う。使うのはオーナー 1 人なので、Access は無料の枠に収まる |
| 社員の状態 | Durable Objects (1 人に 1 つ、alarm) | 合う。勤務の時刻、心拍、仕事の山を持ち続ける役に向く |
| 作業場 | Containers (basic: CPU 4 分の 1、メモリ 1GB、ディスク 4GB) | 合う。外への通信を切り、HTTPS も含めて入口の Worker だけを通す仕組みが文書にある。実際に動くかと、ディスク 4GB でリポジトリと依存が入るかは、作る順 1 で確かめる |
| 記録 | D1 (追記だけ) と、書き手を 1 つにする記録係 (Durable Object) | 合う。1 つのデータベースは 10GB までなので、architecture.md の「記録の量」のとおり年ごとに分ける |
| 会話の記録 | R2 (暗号にして置く) | 合う。大きい物を安く置ける |
| 鍵 | Workers の秘密の置き場 | 合う。入口だけが読む |
| 急がない仕事 | 入口から Claude の一括処理の API | 合う。作業場を起こさずに済む |
| 公開 | GitHub Actions と wrangler | 合う |
| 試験用の環境 | Workers のプレビュー (PR ごと) | 条件付き。下の「公開」を見る |
| 知らせのメール | Cloudflare の Email Service | 今は合わない。下の「知らせのメール」を見る |

確かめた文書: [外への通信](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)、[作業場の大きさ](https://developers.cloudflare.com/containers/platform/limits/)、[プレビュー](https://developers.cloudflare.com/workers/previews/resources/)、[メール](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)、[D1 の上限](https://developers.cloudflare.com/d1/platform/limits/)

## 言語とフレームワーク

| 部分 | 使う物 | 状態 |
| --- | --- | --- |
| 画面 | Vite、React 19、knowidea-ui (土台は Base UI)、エディタは CodeMirror 6 | 決定。モックで使っている |
| 入口 (API) | Hono。画面からは RPC で同じ型で呼ぶ | 決定 |
| 社員の状態 | Durable Objects の素の API | 決定 |
| 作業場 | Node.js と Claude Agent SDK | 決定 |
| 型安全 | Drizzle ORM と Zod (下の節) | 決定 |
| 試験 | Vitest、Playwright (Chrome と Safari、3 つの幅)、oxlint | 決定。CI で回っている |
| 仕様 | OpenSpec | 決定 |
| 3D のオフィス | three.js と VRM | 作る順 6 で決める |

## サーバーは TypeScript にそろえる

入口、社員の状態、作業場、画面を 1 つの言語で書く。Workers と Durable Objects は TypeScript がいちばん手厚く支えられていて、Claude Agent SDK も TypeScript で使える。仕事のほとんどは Claude の API、GitHub、データベースの返事を待つ時間なので、Rust の速さは効かない。ルールの判断と守りは共通の部品にし、入口と作業場の両方から同じ物を使う。操作の種類は型で並べ、`never` での網羅の確かめと lint の規則で、分岐の漏れを検査で落とす。画面とサーバーは同じ型をそのまま使う。

## 型安全は Drizzle と Zod

境目ごとに型を 1 か所で決め、残りはそこから作る。

| 境目 | 使う物 | 型の正本 |
| --- | --- | --- |
| D1 | Drizzle ORM (`drizzle-orm/d1`)。作り替えは drizzle-kit で SQL に起こし、wrangler で当てる | Drizzle の表の定義。行の型は `$inferSelect` と `$inferInsert` から取る |
| API | 入力は Zod と `@hono/zod-validator` で確かめる。出力は型だけで持ち、画面は Hono の RPC で同じ型を受ける | 入力は Zod の形 (型は `z.infer`)、出力は入口の返す値の型 |
| 作業場との受け渡し、設定、外からの通知 | Zod | 共通の部品 (`@know-office/core`) の Zod の形 |

- 外から来る物 (画面の入力、GitHub の通知、作業場の返事、D1 の JSON の列) は、使う前に必ず Zod で確かめる
- 追記だけの表は 2 重に守る。1 つ目は Drizzle の上に追記の関数だけを出し、書き換えと消す関数を作らない事。2 つ目は更新と削除を断るトリガーで、drizzle-kit は作らないので手書きの作り替え (`drizzle-kit generate --custom`) で足し、落ちるテストで在る事を確かめる
- `audit_log` の追記の関数は記録係の Durable Object の中だけに置き、入口と社員の状態は記録係を呼ぶ
- D1 は BEGIN と COMMIT の取引を使えないので、まとめて書く時は `db.batch()` を使う。`audit_log` の「最後の行を読んで次の行を書く」は記録係の中で 1 件ずつ順に行う
- Drizzle を選ぶのは、表の定義から行の型と作り替えの SQL が 1 か所で出るから。素の SQL では型と表がずれやすい

## 画面は Vite と React

画面は Vite、React、knowidea-ui で作り、事前に作った物を入口と同じ Worker から配る。画面ごとにコードを分け、3D とエディタは開いた時だけ読み込む。使いやすさは knowidea-ui の部品で持ち、キーボードだけで操作でき、読み上げで画面の移りが分かり、文字と背景の差を WCAG 2.2 の AA にそろえる。e2e で axe の検査を全画面に掛ける。Next.js は、サーバー側の機能を使わない形になり、入口の Hono と役目が重なるので使わない。

Vite、Vitest、oxlint は VoidZero の道具で、すでに使っている。VoidZero の公開の仕組み Void は、Durable Objects と Containers が使えると確かめられず、社員の状態と作業場を載せられないので今は使わない。使えると分かったら、入口と画面を移せるか見直す。

## エディタは CodeMirror 6

スマートフォンでも動き、軽い。Monaco は携帯端末のブラウザに対応していない。補完と定義への移動は、作業場で動く TypeScript の解析の仕組みから取る。

## 公開

main ブランチに入ると GitHub Actions が検査し、画面、入口、コンテナをまとめて公開する。プルリクエストごとに試験用の環境 (Workers のプレビュー) を作る。プレビューの D1 と R2 は既定で本番と共有されるので、試験用の D1 と R2 を分けて結ぶ。Containers はプレビューで一部だけの対応なので、作業場が起きるかを作る順 1 で確かめ、起きなければ試験用の環境では作業場を起こさない。試験用の D1 と R2 を足しても月 15 ドルの範囲に収まる事も、作る順 1 で確かめる。本番も試験用の環境も、Access で守った URL だけで開く。Cloudflare が自動で付ける URL のうち、Access を通らない物は切る。

## 知らせのメール

Cloudflare の Email Service で、オーナーの確かめたアドレスだけに送る。確かめた宛先への送信は無料。送り元には Cloudflare に載せた独自のドメインが要り、今は持っていない。ドメインを新しく取る時は費用が増えるのでオーナーに聞く。ドメインが整うまでは、要件のメールの知らせ (monitoring と security) は画面の知らせだけで動かす。

