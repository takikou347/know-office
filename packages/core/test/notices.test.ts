// 通知の開く先は画面の中の道だけを受ける (サービスと拡張の 3.5)
import { describe, expect, it } from "vitest";
import { NoticeLink } from "../src/index.ts";

describe("通知の開く先", () => {
  it("画面の中の道は受ける", () => {
    expect(NoticeLink.safeParse("/approvals/0190f4a8-0000-7000-8000-000000000009").success).toBe(true);
    expect(NoticeLink.safeParse("/").success).toBe(true);
  });

  it("// で始まる道 (ほかのオリジン)、外の URL、javascript: は断る", () => {
    const bad = ["//evil", "//evil.example/approvals", "https://evil.example", "javascript:alert(1)", "approvals"];
    expect(bad.filter((link) => NoticeLink.safeParse(link).success)).toEqual([]);
  });
});
