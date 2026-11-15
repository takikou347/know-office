// 画面が仮のデータ (mock.ts) を読まず、API の答えを出す事と、通しのテストがゲートウェイの返事を差し替えない事を確かめる
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCREEN = join(import.meta.dirname, "../../src/screen");

/**
 * まだ仮のデータを読んでいる画面のファイルと、受け持つ Issue。API につないだら消す。デプロイの前に空にする
 */
const STILL_MOCK: Record<string, string> = {
  "pages/dashboard/DashboardPage.tsx": "#107",
  "pages/guard/GuardPage.tsx": "#108",
  "pages/ledger/RecordsPage.tsx": "#107",
  "pages/office/OfficePage.tsx": "#87",
  "pages/office/OfficeScene.tsx": "#87",
  "pages/office/events.ts": "#87",
  "pages/office/feed.ts": "#87",
  "pages/office/layout.ts": "#87",
  "pages/office/motion.ts": "#87",
  "pages/office/room.ts": "#87",
  "pages/services/ServicesPage.tsx": "#109",
  "pages/settings/SettingsPage.tsx": "#108",
  "pages/staff/StaffPage.tsx": "#107",
  "pages/staff/TaskReview.tsx": "#107",
  "parts/staff-status.tsx": "#107",
  "parts/tasks.ts": "#107",
};

/** 画面のソースの拡張子 */
const SOURCE = /\.[cm]?[jt]sx?$/;
/** mock を指す道。import、export、動的 import、引用符の種類を問わず拾う */
const MOCK_PATH = /["'`](?:\.\.?\/)+mock(?:\.[cm]?[jt]sx?)?["'`]/;
/** mock の中身をほかのファイルから読めるようにする書き方。中継を作ると、中継を読む画面を数えられなくなる */
const MOCK_RELAY = /export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+["'`](?:\.\.?\/)+mock(?:\.[cm]?[jt]sx?)?["'`]/;

/**
 * 仮のデータを読む画面のファイルを並べる
 * @returns src/screen からの相対の道。mock.ts 自身は除く
 */
function mockReaders(): string[] {
  return readdirSync(SCREEN, { recursive: true, encoding: "utf8" })
    .filter((name) => SOURCE.test(name) && name !== "mock.ts")
    .filter((name) => MOCK_PATH.test(readFileSync(join(SCREEN, name), "utf8")))
    .toSorted((a, b) => a.localeCompare(b));
}

const E2E = join(import.meta.dirname, "../../e2e");

/**
 * ゲートウェイの返事を route で差し替えている通しのテストと、その数。増やさない。利用場面の通し (e2e/flows/) には置かない
 */
const STUBBED: Record<string, number> = {
  "a11y.spec.ts": 2,
  "guard.spec.ts": 5,
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

describe("画面の仮のデータ", () => {
  it("通しのテストがゲートウェイの返事を差し替える所は、並べた物から増えていない", () => {
    // page、context のどちらの route も、HAR と WebSocket の差し替えも数える
    expect(countIn(/\.(?:route|routeFromHAR|routeWebSocket)\(/g)).toEqual(STUBBED);
    expect(countIn(/addInitScript\(/g)).toEqual(INIT_SCRIPTS);
    // route を取り出して別の名前で呼ぶ書き方は数えられないので、置かない
    expect(countIn(/\{[^}]*\broute(?:FromHAR|WebSocket)?\b[^}]*\}\s*=\s*(?:page|context)/g)).toEqual({});
    expect([...Object.keys(STUBBED), ...Object.keys(INIT_SCRIPTS)].filter((name) => name.startsWith("flows/"))).toEqual([]);
  });

  it("仮のデータを読む画面は、まだつないでいない物として Issue と並べた物だけ", () => {
    expect(mockReaders()).toEqual(Object.keys(STILL_MOCK).toSorted((a, b) => a.localeCompare(b)));
  });

  it("仮のデータを中継するファイルを作っていない", () => {
    const relays = readdirSync(SCREEN, { recursive: true, encoding: "utf8" })
      .filter((name) => SOURCE.test(name))
      .filter((name) => MOCK_RELAY.test(readFileSync(join(SCREEN, name), "utf8")));
    expect(relays).toEqual([]);
  });

  it("デプロイの時は、仮のデータを読む画面が残っていない", () => {
    if (process.env["RELEASE"] !== "1") return;
    expect(Object.keys(STILL_MOCK)).toEqual([]);
  });

  it("デプロイの時は、利用場面の通しがある", () => {
    if (process.env["RELEASE"] !== "1") return;
    const flows = readdirSync(E2E, { recursive: true, encoding: "utf8" }).filter((name) => /^flows\/[^/]+\.spec\.ts$/.test(name));
    expect(flows.length).toBeGreaterThan(0);
  });
});
