// 本番に代わりの物が入らない事を確かめる。ログインと記録の 3.9
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../..");

/**
 * フォルダの下の .ts と .tsx を集める
 * @param dir フォルダ
 * @returns ファイルのパス
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("開発環境の代わりの物", () => {
  it("Worker と画面のコードは dev/ を読まない", () => {
    const offenders = sources(join(root, "src")).filter((file) => /from\s+["'][^"']*\/dev\//.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("本番の設定は ENVIRONMENT が production で、代わりの物の宛先を持たない", () => {
    // wrangler.jsonc のコメントを YAML として読める形にして読む
    const config: unknown = parse(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(config).toMatchObject({ vars: { ENVIRONMENT: "production" } });
    expect(JSON.stringify(config)).not.toContain("DEV_FAKES_URL");
  });
});
