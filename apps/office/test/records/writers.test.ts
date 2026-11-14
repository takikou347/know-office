// 監査ログは記録 DO、エラーログは recordError だけが書く事を確かめる。ログインと記録の 3.4、3.8
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");
const files = readdirSync(src, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
  .map((e) => join(e.parentPath, e.name));

/**
 * 中身が合うファイルを並べる
 * @param pattern 探す形
 * @returns src からのパス
 */
function filesMatching(pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(src, f));
}

describe("監査ログ", () => {
  it("監査ログを書く SQL は records/audit.ts だけにあり、それを呼ぶのは記録 DO だけ", () => {
    expect(filesMatching(/INSERT INTO audit_log/)).toEqual(["gate/records/audit.ts"]);
    expect(filesMatching(/import \{[^}]*\bappendAudit\b/)).toEqual(["gate/do/recorder.ts"]);
  });
});

describe("エラーログ", () => {
  it("エラーログを書く SQL は records/errors.ts の recordError だけにある", () => {
    expect(filesMatching(/INSERT INTO error_events/)).toEqual(["gate/records/errors.ts"]);
  });
});
