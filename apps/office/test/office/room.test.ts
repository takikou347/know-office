import { Color } from "three";
import { describe, expect, it } from "vitest";
import { avatarSourceOf } from "../../src/screen/pages/office/avatars.ts";
import { DOLL_HEIGHT, applyDollPose, buildDoll, dollScaleFor } from "../../src/screen/pages/office/figure.ts";
import { fitToHeight } from "../../src/screen/pages/office/gltf.ts";
import { activityOf, poseOf } from "../../src/screen/pages/office/motion.ts";
import { canShow3d } from "../../src/screen/pages/office/support.ts";
import { OFFICE_THEME, type OfficeThemeId, THEME_IDS, officeThemes, themeOf } from "../../src/screen/pages/office/themes.ts";

// オフィスの 3D の部屋の、three.js を使わずに決まる所 (人形の形、出せるか、案、姿の元)。画面の全体の 3.2

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

  it("待つ時は座って息をし、時々体を揺らす", () => {
    const poses = ticks(100, 100).map((t) => poseOf("wait", t));
    expect(poses.every((p) => p.posture === "sit" && p.paws === 0)).toBe(true);
    expect(span(poses.map((p) => p.lift))).toBeGreaterThan(0);
    expect(span(poses.map((p) => p.lift))).toBeLessThan(0.05);
    expect(span(poses.map((p) => p.sway))).toBeGreaterThan(0.3);
  });

  it("まばたきは時々だけ目を閉じる", () => {
    const poses = ticks(1000, 10).map((t) => poseOf("wait", t));
    const closed = poses.filter((p) => p.blink).length / poses.length;
    expect(closed).toBeGreaterThan(0.01);
    expect(closed).toBeLessThan(0.15);
  });

  it("歩く時は立って、足と体が揺れる", () => {
    const poses = ticks(20, 50).map((t) => poseOf("walk", t));
    expect(poses.every((p) => p.posture === "stand")).toBe(true);
    expect(span(poses.map((p) => p.legs))).toBeGreaterThan(0.3);
    expect(span(poses.map((p) => p.sway))).toBeGreaterThan(0.1);
    expect(poses.every((p) => !("ears" in p) && !("tail" in p))).toBe(true);
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
  it("電話の幅では人形を大きくし、広い幅では机と釣り合う大きさにする", () => {
    expect(dollScaleFor(360)).toBeGreaterThan(dollScaleFor(1280));
    expect(dollScaleFor(599)).toBe(dollScaleFor(360));
    expect(dollScaleFor(600)).toBe(dollScaleFor(1280));
  });

  it("モデルが無い社員は、形を組み合わせた人形にする", () => {
    expect(avatarSourceOf("builder", {})).toEqual({ kind: "shapes" });
  });

  it("VRM のモデルを指した社員は、その URL から読む", () => {
    expect(avatarSourceOf("builder", { builder: "/models/builder.vrm" })).toEqual({ kind: "vrm", url: "/models/builder.vrm" });
  });

  it.each([
    ["/models/staff/builder.glb", { kind: "gltf", url: "/models/staff/builder.glb" }],
    ["/models/staff/builder.gltf", { kind: "gltf", url: "/models/staff/builder.gltf" }],
    ["/models/staff/builder.GLB", { kind: "gltf", url: "/models/staff/builder.GLB" }],
    ["/models/staff/builder.glb?v=2", { kind: "gltf", url: "/models/staff/builder.glb?v=2" }],
    ["/models/staff/builder.vrm#face", { kind: "vrm", url: "/models/staff/builder.vrm#face" }],
    ["/models/staff/builder.obj", { kind: "shapes" }],
    ["/models/staff/builder", { kind: "shapes" }],
  ])("モデルの拡張子で読み方を決める (%s)", (url, source) => {
    expect(avatarSourceOf("builder", { builder: url })).toEqual(source);
  });

  it("glTF のモデルは、人形と同じ背の高さに縮め、足を床に、中心を足元に合わせる", () => {
    const fit = fitToHeight({ x: -1, y: -1.5, z: 2 }, { x: 3, y: 1.5, z: 4 }, DOLL_HEIGHT);
    expect(fit.scale).toBeCloseTo(DOLL_HEIGHT / 3);
    // 縮めた後の足元が (0, 0, 0) に来る
    expect(fit.offset.x + 1 * fit.scale).toBeCloseTo(0);
    expect(fit.offset.y - 1.5 * fit.scale).toBeCloseTo(0);
    expect(fit.offset.z + 3 * fit.scale).toBeCloseTo(0);
  });

  it.each([
    ["高さの無いモデル", { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }, DOLL_HEIGHT],
    ["上下が逆の箱", { x: 0, y: 1, z: 0 }, { x: 1, y: -1, z: 1 }, DOLL_HEIGHT],
    ["0 の背の高さ", { x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 1 }, 0],
  ])("%s は縮めずに置き、数にならない値を出さない", (_, min, max, height) => {
    const fit = fitToHeight(min, max, height);
    expect(fit.scale).toBe(1);
    expect([fit.offset.x, fit.offset.y, fit.offset.z].every(Number.isFinite)).toBe(true);
  });
});

describe("人形の形", () => {
  const paper = new Color("#ffffff");

  it("座ると太ももを前へ、すねを下へ曲げる", () => {
    const doll = buildDoll("#016C6C", null, paper);
    applyDollPose(doll, poseOf("work", 0));
    for (const leg of doll.legs) expect(leg.rotation.x).toBeCloseTo(-Math.PI / 2);
    for (const knee of doll.knees) expect(knee.rotation.x).toBeCloseTo(Math.PI / 2);
  });

  it("歩くと足を前後に振り、腕を足と逆に振る", () => {
    const doll = buildDoll("#016C6C", null, paper);
    applyDollPose(doll, poseOf("work", 0));
    applyDollPose(doll, { ...poseOf("walk", 0), legs: 0.4 });
    expect(doll.legs[0].rotation.x).toBeCloseTo(0.4);
    expect(doll.legs[1].rotation.x).toBeCloseTo(-0.4);
    expect(Math.sign(doll.arms[0].rotation.x)).toBe(-Math.sign(doll.legs[0].rotation.x));
    expect(doll.knees[0].rotation.x).toBe(0);
  });

  it("書類を持つと両腕を前へ出す", () => {
    const doll = buildDoll("#016C6C", null, paper);
    doll.paper.visible = true;
    applyDollPose(doll, { ...poseOf("walk", 0), legs: 0.4 });
    for (const arm of doll.arms) expect(arm.rotation.x).toBeLessThan(-1);
  });

  it("目を閉じる時は目を縦につぶし、困った時は眉を出す", () => {
    const doll = buildDoll("#016C6C", null, paper);
    applyDollPose(doll, { ...poseOf("wait", 0), blink: true, face: "trouble" });
    for (const e of doll.eyes) expect(e.scale.y).toBeLessThan(0.3);
    for (const b of doll.brows) expect(b.visible).toBe(true);
  });
});
