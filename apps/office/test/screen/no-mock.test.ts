// 画面が仮のデータ (mock.ts) を読まず、API の答えを出す事を確かめる。監査 (2026-11-15) で 8 画面のうち 7 画面が仮のデータのまま「済み」になっていた
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

/**
 * 仮のデータを読む画面のファイルを並べる
 * @returns src/screen からの相対の道。mock.ts 自身は除く
 */
function mockReaders(): string[] {
  return readdirSync(SCREEN, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && name !== "mock.ts")
    .filter((name) => /from "(?:\.\.?\/)+mock(?:\.ts)?"/.test(readFileSync(join(SCREEN, name), "utf8")))
    .toSorted((a, b) => a.localeCompare(b));
}

const E2E = join(import.meta.dirname, "../../e2e");

/**
 * ゲートウェイの返事を page.route で差し替えている通しのテストと、その数。増やさない。利用場面の通し (e2e/flows/) には置かない
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

/**
 * 通しのテストのファイルごとに、page.route の数を数える
 * @returns e2e からの相対の道と数。0 のファイルは除く
 */
function stubCounts(): Record<string, number> {
  const counts = readdirSync(E2E, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [name, readFileSync(join(E2E, name), "utf8").split("page.route(").length - 1] as const)
    .filter(([, count]) => count > 0)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(counts);
}

describe("画面の仮のデータ", () => {
  it("通しのテストがゲートウェイの返事を差し替える所は、並べた物から増えていない", () => {
    expect(stubCounts()).toEqual(STUBBED);
    expect(Object.keys(STUBBED).filter((name) => name.startsWith("flows/"))).toEqual([]);
  });

  it("仮のデータを読む画面は、まだつないでいない物として Issue と並べた物だけ", () => {
    expect(mockReaders()).toEqual(Object.keys(STILL_MOCK).toSorted((a, b) => a.localeCompare(b)));
  });

  it("デプロイの時は、仮のデータを読む画面が残っていない", () => {
    if (process.env["RELEASE"] !== "1") return;
    expect(Object.keys(STILL_MOCK)).toEqual([]);
  });
});
