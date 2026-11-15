import { describe, expect, it } from "vitest";
import { avatarSourceOf } from "../../src/screen/pages/office/avatars.ts";
import { poseOf } from "../../src/screen/pages/office/motion.ts";
import { canShow3d } from "../../src/screen/pages/office/support.ts";
import { OFFICE_THEME, type OfficeThemeId, THEME_IDS, officeThemes, themeOf } from "../../src/screen/pages/office/themes.ts";

// オフィスの 3D の部屋の、three.js を使わずに決まる所 (動き、出せるか、案、姿の元)。画面の 3.4

/** 1 秒の間を細かく刻んだ時刻 (ミリ秒) */
const times = Array.from({ length: 20 }, (_, i) => i * 50);

describe("社員の動き", () => {
  it("働く時は席に座り、手を動かし続ける", () => {
    const poses = times.map((t) => poseOf("working", t));
    expect(poses.every((p) => p.seated && p.visible)).toBe(true);
    const arms = poses.map((p) => p.arm);
    expect(Math.max(...arms) - Math.min(...arms)).toBeGreaterThan(0.2);
  });

  it("待つ時は席で手を止め、ゆっくり息をする", () => {
    const poses = times.map((t) => poseOf("paused", t));
    expect(poses.every((p) => p.seated && p.visible && p.arm === 0)).toBe(true);
    const lifts = Array.from({ length: 40 }, (_, i) => poseOf("paused", i * 100).lift);
    const span = Math.max(...lifts) - Math.min(...lifts);
    expect(span).toBeGreaterThan(0);
    // 働く時の手より小さく動く
    expect(span).toBeLessThan(0.1);
  });

  it("止まる時は時刻が進んでも形が変わらず、止めた印を出す", () => {
    const first = poseOf("stopped", 0);
    for (const t of times) expect(poseOf("stopped", t)).toEqual(first);
    expect(first.mark).toBe("stop");
  });

  it("退勤した時は席に居ない", () => {
    const pose = poseOf("off", 0);
    expect(pose.visible).toBe(false);
    expect(pose.lamp).toBe(false);
  });

  it("働く時と待つ時は机の明かりを点ける", () => {
    expect(poseOf("working", 0).lamp).toBe(true);
    expect(poseOf("paused", 0).lamp).toBe(true);
  });
});

/**
 * 確かめに使う作り物のブラウザの口を作る
 * @param o 動きを減らす設定と WebGL の有無
 * @returns 作り物の口
 */
const env = (o: { reduce?: boolean; webgl?: boolean }) => ({
  matchMedia: (q: string) => ({ matches: q.includes("prefers-reduced-motion") && Boolean(o.reduce) }),
  createCanvas: () => ({ getContext: (kind: string) => (o.webgl && kind === "webgl2" ? {} : null) }),
});

/**
 * 案の項目の名前を並べて返す
 * @param id 案の名前
 * @returns 項目の名前の並び
 */
const keysOf = (id: OfficeThemeId) => Object.keys(themeOf(id)).toSorted();

describe("3D を出せるか", () => {
  it("WebGL があり、動きを減らす設定でなければ出す", () => {
    expect(canShow3d(env({ webgl: true }))).toBe(true);
  });

  it("WebGL が無ければ出さない", () => {
    expect(canShow3d(env({ webgl: false }))).toBe(false);
  });

  it("動きを減らす設定なら出さない", () => {
    expect(canShow3d(env({ webgl: true, reduce: true }))).toBe(false);
  });

  it("確かめる途中で投げたら出さない", () => {
    expect(
      canShow3d({
        matchMedia: () => ({ matches: false }),
        createCanvas: () => {
          throw new Error("canvas を作れない");
        },
      }),
    ).toBe(false);
  });
});

describe("部屋の案", () => {
  it("案は 2 から 3 個で、どれも同じ項目を持つ", () => {
    const ids = THEME_IDS;
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.length).toBeLessThanOrEqual(3);
    for (const id of ids) expect(keysOf(id)).toEqual(keysOf(OFFICE_THEME));
  });

  it("使う案は定数の 1 か所で決まり、案の中にある", () => {
    expect(THEME_IDS).toContain(OFFICE_THEME);
    expect(Object.keys(officeThemes).toSorted()).toEqual([...THEME_IDS].toSorted());
  });
});

describe("社員の姿", () => {
  it("VRM のモデルが無い社員は、形を組み合わせた姿にする", () => {
    expect(avatarSourceOf("builder", {})).toEqual({ kind: "shapes" });
  });

  it("VRM のモデルを指した社員は、その URL から読む", () => {
    expect(avatarSourceOf("builder", { builder: "/models/builder.vrm" })).toEqual({ kind: "vrm", url: "/models/builder.vrm" });
  });
});
