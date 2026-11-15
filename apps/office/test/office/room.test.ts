import { describe, expect, it } from "vitest";
import { avatarSourceOf } from "../../src/screen/pages/office/avatars.ts";
import { coatOf, puppyScaleFor } from "../../src/screen/pages/office/figure.ts";
import { furLayersFor } from "../../src/screen/pages/office/fur.ts";
import { activityOf, poseOf } from "../../src/screen/pages/office/motion.ts";
import { canShow3d } from "../../src/screen/pages/office/support.ts";
import { OFFICE_THEME, type OfficeThemeId, THEME_IDS, officeThemes, themeOf } from "../../src/screen/pages/office/themes.ts";

// オフィスの 3D の部屋の、three.js を使わずに決まる所 (子犬の形、出せるか、案、姿の元)。画面の 3.4

/**
 * 時刻 (ミリ秒) を刻んだ並びを作る
 * @param count 数
 * @param step 刻み
 * @returns 時刻の並び
 */
const ticks = (count: number, step: number) => Array.from({ length: count }, (_, i) => i * step);

const span = (values: number[]) => Math.max(...values) - Math.min(...values);

describe("社員の動き", () => {
  it("状態から、することを決める", () => {
    expect(activityOf("working")).toBe("work");
    expect(activityOf("paused")).toBe("wait");
    expect(activityOf("stopped")).toBe("stopped");
    expect(activityOf("off")).toBe("off");
  });

  it("働く時は座って、前足で打ち続ける", () => {
    const poses = ticks(20, 50).map((t) => poseOf("work", t));
    expect(poses.every((p) => p.visible && p.posture === "sit")).toBe(true);
    expect(span(poses.map((p) => p.paws))).toBeGreaterThan(0.2);
  });

  it("待つ時はおすわりで息をし、時々しっぽを振る", () => {
    const poses = ticks(100, 100).map((t) => poseOf("wait", t));
    expect(poses.every((p) => p.posture === "sit" && p.paws === 0)).toBe(true);
    expect(span(poses.map((p) => p.lift))).toBeGreaterThan(0);
    expect(span(poses.map((p) => p.lift))).toBeLessThan(0.05);
    expect(span(poses.map((p) => p.tail))).toBeGreaterThan(0.3);
  });

  it("まばたきは時々だけ目を閉じる", () => {
    const poses = ticks(1000, 10).map((t) => poseOf("wait", t));
    const closed = poses.filter((p) => p.blink).length / poses.length;
    expect(closed).toBeGreaterThan(0.01);
    expect(closed).toBeLessThan(0.15);
  });

  it("動きを止めて描く時刻 0 では、どのすることでも目を開けている", () => {
    for (const a of ["work", "wait", "walk"] as const) expect(poseOf(a, 0).blink).toBe(false);
  });

  it("歩く時は立って、足と耳としっぽが揺れる", () => {
    const poses = ticks(20, 50).map((t) => poseOf("walk", t));
    expect(poses.every((p) => p.posture === "stand")).toBe(true);
    expect(span(poses.map((p) => p.legs))).toBeGreaterThan(0.3);
    expect(span(poses.map((p) => p.ears))).toBeGreaterThan(0.05);
    expect(span(poses.map((p) => p.tail))).toBeGreaterThan(0.1);
  });

  it("止めた時は困り顔で赤い印を出し、時刻が進んでも形が変わらない", () => {
    const first = poseOf("stopped", 0);
    for (const t of ticks(30, 333)) expect(poseOf("stopped", t)).toEqual(first);
    expect(first.face).toBe("trouble");
    expect(first.mark).toBe("stop");
  });

  it("退勤した時は部屋に居ない", () => {
    expect(poseOf("off", 0).visible).toBe(false);
  });
});

/**
 * 作り物の canvas を返す口を作る
 * @param webgl WebGL 2 を出せるか
 * @returns 作り物の口
 */
const env = (webgl: boolean) => ({ createCanvas: () => ({ getContext: (kind: string) => (webgl && kind === "webgl2" ? {} : null) }) });

describe("3D を出せるか", () => {
  it("WebGL 2 があれば出す", () => {
    expect(canShow3d(env(true))).toBe(true);
  });

  it("WebGL 2 が無ければ出さない", () => {
    expect(canShow3d(env(false))).toBe(false);
  });

  it("確かめる途中で投げたら出さない", () => {
    expect(
      canShow3d({
        createCanvas: () => {
          throw new Error("canvas を作れない");
        },
      }),
    ).toBe(false);
  });
});

/**
 * 案の項目の名前を並べて返す
 * @param id 案の名前
 * @returns 項目の名前の並び
 */
const keysOf = (id: OfficeThemeId) => Object.keys(themeOf(id)).toSorted();

describe("部屋の案", () => {
  it("案は 2 から 3 個で、どれも同じ項目を持つ", () => {
    expect(THEME_IDS.length).toBeGreaterThanOrEqual(2);
    expect(THEME_IDS.length).toBeLessThanOrEqual(3);
    for (const id of THEME_IDS) expect(keysOf(id)).toEqual(keysOf(OFFICE_THEME));
  });

  it("使う案は定数の 1 か所で決まり、既定は木の部屋", () => {
    expect(OFFICE_THEME).toBe("wood");
    expect(Object.keys(officeThemes).toSorted()).toEqual([...THEME_IDS].toSorted());
  });
});

describe("社員の姿", () => {
  it("電話の幅では子犬を大きくし、広い幅では机と釣り合う大きさにする", () => {
    expect(puppyScaleFor(360)).toBeGreaterThan(puppyScaleFor(1280));
    expect(puppyScaleFor(599)).toBe(puppyScaleFor(360));
    expect(puppyScaleFor(600)).toBe(puppyScaleFor(1280));
  });

  it("電話の幅では毛の層を減らし、広い幅では毛羽が見えるだけ重ねる", () => {
    expect(furLayersFor(360)).toBeLessThan(furLayersFor(1280));
    expect(furLayersFor(599)).toBe(furLayersFor(360));
    expect(furLayersFor(360)).toBeGreaterThanOrEqual(3);
    expect(furLayersFor(1280)).toBeLessThanOrEqual(12);
  });

  it("3 体は同じ子の毛色違いで、毛色は部屋の案の色から取る", () => {
    const theme = themeOf(OFFICE_THEME);
    expect(coatOf(theme, "president")).toBe(theme.coatPresident);
    expect(coatOf(theme, "builder")).toBe(theme.coatBuilder);
    expect(coatOf(theme, "reviewer")).toBe(theme.coatReviewer);
    expect(new Set(["president", "builder", "reviewer"].map((id) => coatOf(theme, id))).size).toBe(3);
  });

  it("VRM のモデルが無い社員は、形を組み合わせた子犬にする", () => {
    expect(avatarSourceOf("builder", {})).toEqual({ kind: "shapes" });
  });

  it("VRM のモデルを指した社員は、その URL から読む", () => {
    expect(avatarSourceOf("builder", { builder: "/models/builder.vrm" })).toEqual({ kind: "vrm", url: "/models/builder.vrm" });
  });
});
