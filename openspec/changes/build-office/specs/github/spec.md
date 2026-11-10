## ADDED Requirements

### Requirement: ボタン 1 つで連携する

オーナー SHALL office の設定の「GitHub と連携する」を押し、GitHub の画面で「作成」と「インストール」を押すだけで連携できる。know-office 専用の非公開の GitHub App を作り、オーナーのアカウントにだけ入れる。

#### Scenario: 連携する

- **WHEN** オーナーが連携のボタンを押し、GitHub の画面で 2 回押す
- **THEN** App が作られて入り、選んだリポジトリが know-office から見える

#### Scenario: やめる

- **WHEN** オーナーが GitHub の画面で App を外す
- **THEN** know-office から GitHub の操作ができなくなる

### Requirement: App の鍵

App の元の鍵 MUST 鍵の置き場に置き、入口だけが読む。GitHub を呼ぶ時は、リポジトリ 1 つと要る操作だけに絞った、1 時間で切れる鍵を入口が作って付ける。作業場には GitHub の鍵を渡さない。App は、オーナーが選んでいないリポジトリ、アカウントの設定、支払いには届かない。

#### Scenario: 絞った鍵

- **WHEN** 作業場が knowidea-ui への push を入口に頼む
- **THEN** 入口は knowidea-ui だけに書ける 1 時間の鍵を付けて GitHub に送る

#### Scenario: 選んでいないリポジトリ

- **WHEN** 社員が連携で選んでいないリポジトリへの操作を求める
- **THEN** 入口が断る

#### Scenario: 全体が止まる

- **WHEN** 自動の守りが全体を止める
- **THEN** 元の鍵が自動で取り替わる

### Requirement: GitHub のルール

オーナー SHALL 社員が GitHub で何をしてよいかを設定の画面で決められる。office の設定に初期値を置き、1 は office 全体の設定で、サービスのリポジトリはこの中から選ぶ。2 から 5 はサービスごとの設定で変えられる。6 は office 全体とサービスごとの両方で使える。

1. 触れるリポジトリ。初期値は連携したものすべて
2. できる操作。読む、ブランチを作る、push、プルリクエスト、main ブランチへの取り込み、Issue。初期値はすべて
3. main ブランチに入れる条件。初期値は検査と見る役の可
4. 本番に公開する条件。初期値はオーナーの可。knowidea-ui はサービスごとの設定で検査と見る役の可にする
5. 触れない所。初期値は GitHub Actions の設定と鍵の設定
6. 手で止める。初期値は止めない

#### Scenario: できる操作を絞る

- **WHEN** オーナーがあるサービスで main ブランチへの取り込みを外す
- **THEN** 社員がそのリポジトリで取り込みを求めると入口が断る

#### Scenario: 触れない所

- **WHEN** 社員が GitHub Actions の設定を変える push を求める
- **THEN** 入口が断り、ルールの外の操作として数える

### Requirement: ブランチの保護をルールから掛ける

know-office SHALL main ブランチに入れる条件を GitHub のブランチの保護として掛ける。オーナーが GitHub の設定を触る事は無い。

#### Scenario: 条件を変える

- **WHEN** オーナーが main ブランチに入れる条件にオーナーの可を足す
- **THEN** GitHub の側の保護も同じ条件になる

### Requirement: 通知を受ける

know-office SHALL プルリクエストや検査の結果を GitHub からの通知で受け、仕事とレビューの画面に出す。

#### Scenario: 検査が終わる

- **WHEN** GitHub から検査の結果の通知が届く
- **THEN** レビューの画面の検査の結果が新しくなる

### Requirement: App を通した操作を記録する

App を通した操作 MUST すべて記録し、普段と違う動きは自動の守りに渡す。

#### Scenario: 操作の記録

- **WHEN** 社員がプルリクエストを出す
- **THEN** どの社員がどの仕事で出したかが記録に残る
