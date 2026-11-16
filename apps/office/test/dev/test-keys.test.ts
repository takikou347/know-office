// テストの鍵の手伝いが、1 つのテストの中では毎回別の鍵を渡し、テストをまたいでは作った鍵を使い回す事を確かめる
import { describe, expect, it } from "vitest";
import { accessKeyPair, githubAppKey } from "../helpers/keys.ts";

/** 前のテストで渡した鍵 */
const seen: { access: CryptoKeyPair[]; github: ReturnType<typeof githubAppKey>[] } = { access: [], github: [] };

describe("テストの鍵", () => {
  it("1 つのテストの中では、Access と GitHub のどちらにも毎回別の鍵を渡す", async () => {
    seen.access = [await accessKeyPair(), await accessKeyPair()];
    seen.github = [githubAppKey(), githubAppKey()];
    expect(seen.access[0]).not.toBe(seen.access[1]);
    expect(seen.github[0]).not.toBe(seen.github[1]);
  });

  it("次のテストは、前のテストで作った鍵を頭から使い回す", async () => {
    expect(await accessKeyPair()).toBe(seen.access[0]);
    expect(await accessKeyPair()).toBe(seen.access[1]);
    expect(githubAppKey()).toBe(seen.github[0]);
  });
});
