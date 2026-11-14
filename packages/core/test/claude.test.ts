// Claude のモデルの単価、役ごとのモデル、鍵の入れ物を確かめる (社員が考えるの 3.3)
import { describe, expect, it } from "vitest";
import { allowedModels, costMicroUsd, Secret } from "../src/index.ts";

describe("Claude の単価", () => {
  it("入力、出力、読み直し、書き込みのトークンから百万分の 1 ドルを出す", () => {
    const usage = { inputTokens: 50, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 2000 };
    // 4、20、0.2、5 ドル / 百万
    expect(costMicroUsd("claude-opus-5-5", usage)).toBe(200 + 2000 + 200 + 10_000);
    // 2、10、0.1、2.5 ドル / 百万
    expect(costMicroUsd("claude-sonnet-5-5", usage)).toBe(100 + 1000 + 100 + 5000);
  });

  it("軽いタスクのモデルは端数を切り上げ、入力が 10 万を超えると高い方の単価にする", () => {
    // 0.3 + 0.5 を切り上げて 1
    expect(costMicroUsd("claude-haiku-5-5", { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(1);
    // 0.5、2.5、0.05 ドル / 百万
    expect(costMicroUsd("claude-haiku-5-5", { inputTokens: 50_000, outputTokens: 10, cacheReadTokens: 60_000, cacheWriteTokens: 0 })).toBe(25_000 + 25 + 3000);
  });

  it("単価表に無いモデルは null を返す", () => {
    expect(costMicroUsd("claude-unknown", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});

describe("役ごとのモデル", () => {
  it("社長とレビュー担当は Opus、開発担当は Sonnet、どの役も軽いタスクに Haiku を使える", () => {
    expect(allowedModels("president")).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(allowedModels("reviewer")).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(allowedModels("builder")).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
  });
});

describe("鍵の入れ物", () => {
  it("文字や JSON にすると伏せ、reveal でだけ中身を返す", () => {
    const secret = new Secret("sk-ant-real");
    expect(String(secret)).toBe("***");
    expect(JSON.stringify({ secret })).toBe('{"secret":"***"}');
    expect(secret.reveal()).toBe("sk-ant-real");
  });
});
