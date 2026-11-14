## Context

この変更の基本設計は [docs/architecture.md](../../../docs/architecture.md) と [docs/stack.md](../../../docs/stack.md) にある。ここには作る段ごとの詳細設計を、その段を作る直前に節として足す。

詳細の正本は、コードの型、Zod の形、Drizzle の表の定義と D1 の作り替え、テストに置く。ここには決めた理由と表の形だけを書き、同じ事を 2 か所に書かない。この変更を specs に移す時、このファイルも消える。後に残すべき決めは docs/ に移す。

## Goals / Non-Goals

**Goals:**

- 次に作る段の API の道、D1 の表の列、Durable Objects の受け口、作業場の起こし方を、作る前に 1 か所で見られるようにする

**Non-Goals:**

- 先の段の詳細を前もって書く事。作る時に古くなる

## Decisions

段の節はまだ無い。最初は tasks.md の 4.0 で「土台」の節を足す。
