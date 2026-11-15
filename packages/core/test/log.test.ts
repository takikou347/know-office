// ログとエラーログに鍵を残さない事を確かめる。4-foundation.md の 3.8
import { describe, expect, it } from "vitest";
import { redact, redactPublic, redactText } from "../src/index.ts";

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

describe("外に出す文を伏せる", () => {
  it.each([
    ["GitHub のトークン", "push failed: ghs_16C7e42F292c6912E7710c838347Ae178B4a", "16C7e42F292c6912E7710c838347Ae178B4a"],
    ["語の途中の Claude の鍵", "keysk-ant-api03-abcDEF123", "abcDEF123"],
    ["sk- で始まる鍵", "rejected sk-proj-AbCdEf123456", "AbCdEf123456"],
    ["JWT", "jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl expired", "eyJhbGciOiJSUzI1NiJ9"],
    ["メール", "owner taro.yamada+ko@mail.example not allowed", "taro.yamada+ko@mail.example"],
    ["UUID の ID", "node 0190f4a8-1c2d-7e3f-8a9b-0c1d2e3f4a5b not found", "0190f4a8-1c2d-7e3f-8a9b-0c1d2e3f4a5b"],
    ["大文字の UUID", "id 0190F4A8-1C2D-7E3F-8A9B-0C1D2E3F4A5B", "0190F4A8-1C2D-7E3F-8A9B-0C1D2E3F4A5B"],
    ["16 桁以上の 16 進数の ID", "trace 0af7651916cd43dd8448eb211c80319c failed", "0af7651916cd43dd8448eb211c80319c"],
    ["鍵らしい長い文字列", "signature Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl mismatch", "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl"],
    ["URL の userinfo", "fetch https://user:hunter2@api.test/x", "hunter2"],
    ["名前=値", "api_key=abc123&x=1", "abc123"],
    ["Bearer の短い値", "upstream said Bearer x9 rejected", "x9"],
    ["Bearer: の後の値", "header bearer: q7z invalid", "q7z"],
    ["3 つ目の部分の無い JWT 風の文字列", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0 cut", "eyJzdWIiOiJ4In0"],
  ])("%s を伏せる", (_, text, value) => {
    const out = redactPublic(text);
    expect(out).not.toContain(value);
    expect(out).toContain("[伏せた]");
  });

  it("鍵や ID の無い文は変えない", () => {
    const text = "GET /api/v1/nodes が 500 を返した。TypeError: undefined を読んだ (12 回、2026-12-01 10:00)";
    expect(redactPublic(text)).toBe(text);
  });

  it("識別子は残す", () => {
    const text = "staff_rule_denied_count_2026_limit と max_retry_per_task_v2_threshold と workspace-heartbeat-timeout-v2 を超えた";
    expect(redactPublic(text)).toBe(text);
  });

  it("15 桁までの 16 進数と、数字だけの番号は変えない", () => {
    expect(redactPublic("commit 0af7651916cd43d と PR 1234567")).toBe("commit 0af7651916cd43d と PR 1234567");
  });
});
