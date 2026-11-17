// 全部の通しの後に、開発の入口 (pnpm dev) の D1 と DO の置き場が、通しの前と同じかを確かめる。
// 通しの片付けはパスキーを消し、通知を既読にするので、開発の置き場に書くと手元の状態が変わる。同じ時に pnpm dev で書いても落ちる
import { readFileSync } from "node:fs";
import { expect, test as teardown } from "@playwright/test";
import { DEV_SNAPSHOT, devStateFiles } from "./helpers/state.ts";

teardown("通しの後も、開発の D1 と DO の置き場は変わらない", () => {
  const before: unknown = JSON.parse(readFileSync(DEV_SNAPSHOT, "utf8"));
  expect(devStateFiles()).toEqual(before);
});
