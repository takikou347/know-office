// 通しのテストがゲートウェイの返事を差し替えない事と、デプロイの時に利用場面の通しがある事を確かめる
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 通しのテストのソースの拡張子 */
const SOURCE = /\.[cm]?[jt]sx?$/;

const E2E = join(import.meta.dirname, "../../e2e");

/**
 * ゲートウェイの返事を route で差し替えている通しのテストと、その数。増やさない。利用場面の通し (e2e/flows/) には置かない
 */
const STUBBED: Record<string, number> = {
  "a11y.spec.ts": 3,
  "guard.spec.ts": 3,
  "helpers/guard.ts": 3,
  "helpers/review.ts": 1,
  "keys.spec.ts": 5,
  "notices.spec.ts": 2,
  "office.spec.ts": 3,
  "screens.spec.ts": 1,
};

/** ページに先に入れるスクリプトを持つファイルと、その数。fetch を差し替える道になるので増やさない。今は WebGL を無くす 1 つだけ */
const INIT_SCRIPTS: Record<string, number> = { "helpers/webgl.ts": 1 };

/**
 * 通しのテストのファイルごとに、書き方の出る数を数える
 * @param pattern 数える書き方
 * @returns e2e からの相対の道と数。0 のファイルは除く
 */
function countIn(pattern: RegExp): Record<string, number> {
  const counts = readdirSync(E2E, { recursive: true, encoding: "utf8" })
    .filter((name) => SOURCE.test(name))
    .map((name) => [name, readFileSync(join(E2E, name), "utf8").match(pattern)?.length ?? 0] as const)
    .filter(([, count]) => count > 0)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(counts);
}

describe("通しのテストの差し替え", () => {
  it("通しのテストがゲートウェイの返事を差し替える所は、並べた物から増えていない", () => {
    // page、context のどちらの route も、HAR と WebSocket の差し替えも数える
    expect(countIn(/\.(?:route|routeFromHAR|routeWebSocket)\(/g)).toEqual(STUBBED);
    expect(countIn(/addInitScript\(/g)).toEqual(INIT_SCRIPTS);
    // route を取り出して別の名前で呼ぶ書き方は数えられないので、置かない
    expect(countIn(/\{[^}]*\broute(?:FromHAR|WebSocket)?\b[^}]*\}\s*=\s*(?:page|context)/g)).toEqual({});
    expect([...Object.keys(STUBBED), ...Object.keys(INIT_SCRIPTS)].filter((name) => name.startsWith("flows/"))).toEqual([]);
  });

  it("デプロイの時は、利用場面の通しがある", () => {
    if (process.env["RELEASE"] !== "1") return;
    const flows = readdirSync(E2E, { recursive: true, encoding: "utf8" }).filter((name) => /^flows\/[^/]+\.spec\.ts$/.test(name));
    expect(flows.length).toBeGreaterThan(0);
  });
});
