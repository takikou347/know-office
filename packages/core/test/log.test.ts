// ログとエラーログに鍵を残さない事を確かめる。4-foundation.md の 3.8
import { describe, expect, it } from "vitest";
import { redact, redactText } from "../src/index.ts";

describe("鍵を伏せる", () => {
  it.each([
    ["GitHub のトークンの頭", "failed with ghp_ABCDEF123456", "ABCDEF123456"],
    ["GitHub の細かいトークン", "github_pat_11ABC_def456", "11ABC_def456"],
    ["Claude の API キー", "key sk-ant-api03-xyz789 rejected", "xyz789"],
    ["Bearer の値", "sent Bearer abc123def", "abc123def"],
    ["Authorization の行", "Authorization: Bearer abc123def", "abc123def"],
    ["Cookie の行の全ての値", "Cookie: a=first; c=second", "second"],
    ["JSON の中の名前と値", '{"token":"abc123"}', "abc123"],
    ["名前=値", "secret=abc123&x=1", "abc123"],
    ["名前: 値", "password: hunter2", "hunter2"],
  ])("%s を伏せる", (_, text, value) => {
    const out = redactText(text);
    expect(out).not.toContain(value);
    expect(out).toContain("[伏せた]");
  });

  it("鍵の無い文は変えない", () => {
    expect(redactText("D1 が応答しない (traceId 0af7651916cd43dd)")).toBe("D1 が応答しない (traceId 0af7651916cd43dd)");
  });

  it("鍵らしい名前の項目は値ごと伏せ、ほかの項目の文も伏せる", () => {
    expect(redact({ apiKey: "x", nested: { message: "token=abc" }, list: ["Bearer zzz"] })).toEqual({
      apiKey: "[伏せた]",
      nested: { message: "token=[伏せた]" },
      list: ["Bearer [伏せた]"],
    });
  });
});
