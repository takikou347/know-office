// 開発用の変数を 1 か所 (.dev.vars) から読む事を確かめる。ログインと記録の 3.9
import { describe, expect, it } from "vitest";
import { parseDevVars } from "../../dev/plugin.ts";

describe("開発環境の代わりの物", () => {
  it("代わりの Access の設定とポートを .dev.vars から読む", () => {
    const vars = parseDevVars("# 説明\nENVIRONMENT=development\nDEV_FAKES_URL=http://localhost:5199\nACCESS_TEAM=dev\nACCESS_AUD=dev-aud\nOWNER_EMAIL=owner@example.com\n");
    expect(vars).toEqual({ port: 5199, team: "dev", aud: "dev-aud", email: "owner@example.com" });
  });

  it("要る値が無ければ止まる", () => {
    expect(() => parseDevVars("ACCESS_TEAM=dev\n")).toThrow(".dev.vars に DEV_FAKES_URL が無い");
  });
});
