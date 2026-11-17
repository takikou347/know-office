// 開発用の変数を 1 か所 (.dev.vars) から読む事と、費用の出る変数の初期値を確かめる。ログインと記録の 3.8、3.9、タスクとレビューの 3.6
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { parseDevVars } from "../../dev/plugin.ts";

const ROOT = join(import.meta.dirname, "../..");

/** wrangler.jsonc の vars。コメントを落として YAML として読む */
const Config = z.object({ vars: z.record(z.string(), z.string()), previews: z.object({ vars: z.record(z.string(), z.string()) }).loose() }).loose();

describe("開発環境の代わりの物", () => {
  it("代わりの Access の設定とポートを .dev.vars から読む", () => {
    const vars = parseDevVars("# 説明\nENVIRONMENT=development\nDEV_FAKES_URL=http://localhost:5199\nACCESS_TEAM=dev\nACCESS_AUD=dev-aud\nOWNER_EMAIL=owner@example.com\nANTHROPIC_API_KEY=dev-key\n");
    expect(vars).toEqual({ port: 5199, team: "dev", aud: "dev-aud", email: "owner@example.com", claudeKey: "dev-key" });
  });

  it("要る値が無ければ止まる", () => {
    expect(() => parseDevVars("ACCESS_TEAM=dev\n")).toThrow(".dev.vars に DEV_FAKES_URL が無い");
  });
});

describe("ワークスペースを起こす時", () => {
  it("production と preview の EDITOR_WAKE は off", () => {
    const config = Config.parse(parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "")));
    expect([config.vars["EDITOR_WAKE"], config.previews.vars["EDITOR_WAKE"]]).toEqual(["off", "off"]);
  });

  it(".dev.vars.example の EDITOR_WAKE は on", () => {
    expect(readFileSync(join(ROOT, ".dev.vars.example"), "utf8").split("\n")).toContain("EDITOR_WAKE=on");
  });
});
